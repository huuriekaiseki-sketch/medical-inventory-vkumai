#!/usr/bin/env bash
# WHY(2026-09-10、レビューの設計提案 2「境界を横断するケース」): 観測の鎖——
#      **テストが赤 → 結果 JSON → 鮮度の判定 → 終える瞬間の停止**——を、
#      輪ごとではなく**鎖として**通す。
#
#      いまは各輪にそれぞれ検査があるが、どれも**自前の fixture**を使う。
#      つまり「run-integration-tests.sh が書く欄の名前」と
#      「run-freshness.py が読む欄の名前」が食い違っても、両方の検査が緑のまま通る。
#      片方の fixture だけ直せば、鎖は切れたまま誰も気づかない（C-051 と同じ「境界」の型）。
#
#      ここでは**実物の 3 本**を順に呼び、**同じ 1 つの記録**を受け渡す:
#        1. scripts/run-integration-tests.sh  … 偽 vitest で赤／緑を作り、記録を書かせる
#        2. scripts/check-integration-freshness.sh … その記録を読んで警告するか
#        3. scripts/check-full-run-before-finish.sh … 終える瞬間に止めるか
#
#      あわせて **R06 の鎖**（テストは緑だが後片付けが漏れた回）も通す。
#      こちらは 2026-09-10 に作ったばかりで、鎖として一度も通していなかった。
#
# 限界:
#   - 実 DB は使わない（vitest を偽物に差し替える）。**テストの中身は測らない**
#   - 鎖の 3 本だけを見る。E2E・変異計測の鎖は別（同じ run-freshness.py を通るので、
#     欄の名前が変われば統合テスト側で先に落ちる）
#   - 「警告文が出るか」までで、**人がそれを読むか**は測れない
#
# 実行: bash scripts/check-observability-chain.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER="$SCRIPT_DIR/run-integration-tests.sh"
FRESHNESS="$SCRIPT_DIR/check-integration-freshness.sh"
STOP_HOOK="$SCRIPT_DIR/check-full-run-before-finish.sh"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
assert_contains() {
  if grep -qF -- "$2" <<<"$1"; then ok "$3"; else
    ng "$3" "期待: $2"; echo "      実際: $1"; fi
}
assert_not_contains() {
  if grep -qF -- "$2" <<<"$1"; then ng "$3" "出てはいけない: $2"; else ok "$3"; fi
}

command -v jq >/dev/null 2>&1 || { echo "jq が要ります"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
LOG_DIR="$WORK/logs"
LEAK_FILE="$WORK/leak.json"
mkdir -p "$LOG_DIR"

# 偽 vitest。CHAIN_MODE で「赤／緑／緑だが後片付けが漏れた」を作り分ける
cat > "$WORK/fake-vitest" <<'SH'
#!/usr/bin/env bash
case "${CHAIN_MODE:-green}" in
  red)    printf '{"leaked":[],"count":0}' > "$INTEGRATION_LEAK_REPORT"; exit 1 ;;
  leak)   printf '{"leaked":["products: p1"],"count":1}' > "$INTEGRATION_LEAK_REPORT"; exit 0 ;;
  green)  printf '{"leaked":[],"count":0}' > "$INTEGRATION_LEAK_REPORT"; exit 0 ;;
esac
SH
chmod +x "$WORK/fake-vitest"

# 鎖の 1 本目。**実物**の run-integration-tests.sh を呼ぶ（記録の欄の名前もここが決める）
run_suite() { # $1 = CHAIN_MODE
  rm -f "$LOG_DIR/integration-runs.jsonl" "$LEAK_FILE"
  CHAIN_OUT="$(
    CHAIN_MODE="$1" \
    RIT_ENV_FILE="" \
    RIT_PILEUP_THRESHOLD="" \
    AIDD_LOG_DIR="$LOG_DIR" \
    RIT_LEAK_REPORT="$LEAK_FILE" \
    RIT_VITEST_BIN="$WORK/fake-vitest" \
      bash "$RUNNER" 2>&1
  )"
  CHAIN_CODE=$?
}

# 鎖の 2 本目。**同じ記録**を読ませる
run_freshness() {
  FRESH_OUT="$(AIDD_LOG_DIR="$LOG_DIR" bash "$FRESHNESS" 2>&1)"
}

# 鎖の 3 本目。**同じ記録**を読ませる。セッション ID を毎回変えて「1 回だけ」の抑止を避ける
run_stop_hook() {
  STOP_OUT="$(
    AIDD_LOG_DIR="$LOG_DIR" \
    FULL_RUN_CHECK_ROOT="$REPO_ROOT" \
    FULL_RUN_CHECK_SESSION_ID="chain-$RANDOM-$RANDOM" \
    FULL_RUN_CHECK_MARKER="$WORK/marker.json" \
      bash "$STOP_HOOK" 2>&1
  )"
}

echo "=== scenario 1: テストが赤 → 記録 → 鮮度 → 停止判定まで繋がっている ==="
run_suite red
if [ "$CHAIN_CODE" -ne 0 ]; then ok "1本目: 赤い実行は赤で返る"; else ng "赤いのに exit 0" "$CHAIN_OUT"; fi
LAST="$(tail -n 1 "$LOG_DIR/integration-runs.jsonl" 2>/dev/null || echo '')"
assert_contains "$LAST" '"result": "fail"' "1本目: 記録に総合 fail が残る"
assert_contains "$LAST" '"testResult": "fail"' "1本目: テストが赤だと分かる形で残る"

run_freshness
assert_contains "$FRESH_OUT" "失敗" "2本目: 鮮度の判定が赤を拾う"
assert_contains "$FRESH_OUT" "run-integration-tests.sh" "2本目: 回し方を案内する"

run_stop_hook
assert_contains "$STOP_OUT" "統合テスト" "3本目: 終える瞬間に統合テストを名指しする"
assert_contains "$STOP_OUT" "失敗" "3本目: 赤のまま終えようとしていると言う"

echo "=== scenario 2: テストは緑だが後片付けが漏れた（R06 の鎖） ==="
# WHY: 2026-09-10 まで、漏れがあっても記録は pass だった。記録しか見ない鮮度の判定は
#      それを良い実行として信じる。**鎖として一度も通していなかった**
run_suite leak
if [ "$CHAIN_CODE" -ne 0 ]; then ok "1本目: 漏れがあれば赤で返る"; else ng "漏れがあるのに exit 0" "$CHAIN_OUT"; fi
LAST="$(tail -n 1 "$LOG_DIR/integration-runs.jsonl" 2>/dev/null || echo '')"
assert_contains "$LAST" '"result": "fail"' "1本目: 総合は fail"
assert_contains "$LAST" '"testResult": "pass"' "1本目: テスト自体は緑だったと分かる"
assert_contains "$LAST" '"dataGuardResult": "fail"' "1本目: 落ちたのはデータ検査だと分かる"

run_freshness
assert_contains "$FRESH_OUT" "失敗" "2本目: 鮮度の判定が漏れの回を赤として拾う"

run_stop_hook
assert_contains "$STOP_OUT" "統合テスト" "3本目: 終える瞬間に止める"

echo "=== scenario 3: 全部緑なら鎖のどこも鳴らない（対照） ==="
# WHY: 落ちる側だけを測ると「常に鳴る」実装でも scenario 1・2 は通ってしまう
run_suite green
if [ "$CHAIN_CODE" -eq 0 ]; then ok "1本目: 緑なら exit 0"; else ng "緑なのに落ちる" "$CHAIN_OUT"; fi
LAST="$(tail -n 1 "$LOG_DIR/integration-runs.jsonl" 2>/dev/null || echo '')"
assert_contains "$LAST" '"result": "pass"' "1本目: 記録も pass"

run_freshness
assert_not_contains "$FRESH_OUT" "失敗" "2本目: 緑なら赤の警告を出さない"

run_stop_hook
assert_not_contains "$STOP_OUT" "統合テストは **失敗**" "3本目: 緑なら止めない"

echo "=== scenario 4: 記録の欄の名前がずれても黙らない（fail-closed） ==="
# WHY(2026-09-10 に実測して前提を訂正): この検査を書いたとき、
#      「1 本目が書く欄と 2 本目が読む欄の名前がずれたら**黙って通る**」と想定していた。
#      実際は逆で、**読めない欄は pass ではない**ので赤として鳴る（fail-closed）。
#      想定より良い性質だったので、そちらを固定する——
#      **鎖が切れたときに黙るのが最悪**で、鳴るなら気づける。
run_suite green   # 緑の記録から始める（赤いままだと「元から赤い」のと区別できない）
run_freshness
assert_not_contains "$FRESH_OUT" "失敗" "前提: 緑の記録では鳴らない"

python3 - "$LOG_DIR/integration-runs.jsonl" <<'PY'
import json, sys
path = sys.argv[1]
rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
# 「result」を別名にする＝1 本目の書き方が変わったのに 2 本目が追随していない状態
for r in rows:
    r["outcome"] = r.pop("result")
with open(path, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
PY
run_freshness
assert_contains "$FRESH_OUT" "失敗" "欄の名前がずれたら、黙らずに鳴る（読めない欄を合格と読まない）"

run_stop_hook
assert_contains "$STOP_OUT" "統合テスト" "終える瞬間も同じく鳴る"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
