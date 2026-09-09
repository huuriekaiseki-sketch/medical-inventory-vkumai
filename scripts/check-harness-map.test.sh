#!/usr/bin/env bash
# WHY(2026-09-10): ハーネスの地図（docs/agents/harness-map.md）を手で書いていたら、
#      **同じ日に台帳の数字を 2 回取り違えた**（別の台帳の数を足した／数える単位を取り違えた）。
#      表を生成物にし、数字は台帳の実物から読むようにしたので、その仕組みの回帰テスト。
#
#      この検査が空振りすると「地図は最新」で緑になる（いちばん危ない外れ方）ので、次を固定する:
#
#   1. 実物の登録簿に違反が無く、生成物が最新である
#   2. 起動・状態の語彙から外れたら落ちる（`人` を `たぶん人` と書けない）
#   3. 宣言した入口・検査・限界の文書が**実在しない**と落ちる（地図に書いてあるのに無い、を止める）
#   4. 台帳が読めない・数字でないと落ちる
#   5. 検査を 1 つも持たないハーネスは落ちる（「あると言っているだけ」を止める）
#   6. 登録簿を読めていないとき（0 件）は落ちる（fail-open 防止）
#   7. 生成物が古いと `--check` が落ちる（**最新なら通る**の対照つき）
#   8. 登録簿が無い導入先は対象 0 件で通る（エンジンだけ配られた先で赤くしない）
#
# 実行: bash scripts/check-harness-map.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
RENDER="$SCRIPT_DIR/render-harness-map.sh"
ENGINE="$SCRIPT_DIR/lib/render-harness-map.mjs"

fail=0
assert_eq() {
  if [ "$1" = "$2" ]; then echo "  OK: $3"; else
    echo "  NG: $3"; echo "      expected: $2"; echo "      actual:   $1"; fail=1; fi
}
assert_contains() {
  if printf '%s' "$1" | grep -qF -- "$2"; then echo "  OK: $3"; else
    echo "  NG: $3"; echo "      expected to find: $2"; echo "      actual: $1"; fail=1; fi
}

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# fixture の土台。`--root` に渡す小さなリポジトリを作る
mkdir -p "$WORK/root/scripts/lib" "$WORK/root/docs"
printf '#!/usr/bin/env bash\n' > "$WORK/root/scripts/entry.sh"
printf '# doc\n' > "$WORK/root/docs/limits.md"
printf '#!/usr/bin/env bash\n' > "$WORK/root/scripts/check-thing.test.sh"
printf '{"pending": [1, 2, 3]}' > "$WORK/root/scripts/lib/ledger.json"

write_registry() { # $1 = ハーネス 1 件の JSON
  cat > "$WORK/registry.json" <<JSON
{
  "generatedMarker": "m",
  "output": "docs/map.md",
  "triggers": { "機械": "a", "人": "b", "外部待ち": "c" },
  "harnesses": [ $1 ]
}
JSON
}
GOOD='{
  "id": "H-01", "role": "テスト", "guards": "何かを守る",
  "trigger": "機械", "triggerDetail": "毎回",
  "entrypoints": ["scripts/entry.sh", "run-the-suite"],
  "checks": ["scripts/check-thing.test.sh"],
  "ledgers": [{ "name": "借金", "unit": "件", "file": "scripts/lib/ledger.json", "path": "pending.length" }],
  "limitsDoc": "docs/limits.md", "state": "あり"
}'

write_doc() {
  printf '# 地図\n\n<!-- generated:m start -->\n<!-- generated:m end -->\n\nおわり\n' > "$WORK/root/docs/map.md"
}

run_engine() { # $@ = engine の引数。出力と終了コードをグローバルに置く
  # WHY(副シェルを作らない): `OUT="$(run_engine ...)"` と書くと終了コードが親に返らず、
  #      **落ちる側を測れなくなる**（2026-09-09・2026-09-10 に 2 回踏んだ）
  ENGINE_OUT="$(node "$ENGINE" "$WORK/registry.json" --root "$WORK/root" "$@" 2>&1)"
  ENGINE_CODE=$?
}

echo "=== scenario 1: 実物の登録簿に違反が無く、生成物が最新 ==="
OUT="$(bash "$RENDER" --check 2>&1)"
CODE=$?
assert_eq "$CODE" "0" "実物が最新（違反 0 件）"
assert_contains "$OUT" "最新" "最新だと言う"

echo "=== scenario 7: 生成物が古いと落ちる（最新なら通る、の対照つき） ==="
write_registry "$GOOD"
write_doc
run_engine
assert_eq "$ENGINE_CODE" "0" "書き出しは通る"
run_engine --check
assert_eq "$ENGINE_CODE" "0" "書き出した直後は最新（対照）"
# 台帳の数字だけを変える → 生成物が古くなる
printf '{"pending": [1, 2]}' > "$WORK/root/scripts/lib/ledger.json"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "台帳の数字が変わったら古いと言う"
assert_contains "$ENGINE_OUT" "作り直す" "作り直し方を案内する"
printf '{"pending": [1, 2, 3]}' > "$WORK/root/scripts/lib/ledger.json"

echo "=== scenario 2: 起動・状態の語彙から外れたら落ちる ==="
write_registry "$(printf '%s' "$GOOD" | sed 's/"trigger": "機械"/"trigger": "たぶん人"/')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "知らない起動の語で落ちる"
assert_contains "$ENGINE_OUT" "unknown-trigger" "起動の語を名指しする"

write_registry "$(printf '%s' "$GOOD" | sed 's/"state": "あり"/"state": "だいたい"/')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "知らない状態の語で落ちる"
assert_contains "$ENGINE_OUT" "unknown-state" "状態の語を名指しする"

echo "=== scenario 3: 宣言したものが実在しないと落ちる ==="
write_registry "$(printf '%s' "$GOOD" | sed 's#scripts/entry.sh#scripts/nope.sh#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "入口が無いと落ちる"
assert_contains "$ENGINE_OUT" "missing-entrypoint" "無い入口を名指しする"

write_registry "$(printf '%s' "$GOOD" | sed 's#scripts/check-thing.test.sh#scripts/check-nope.test.sh#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "検査が無いと落ちる"
assert_contains "$ENGINE_OUT" "missing-check" "無い検査を名指しする"

write_registry "$(printf '%s' "$GOOD" | sed 's#docs/limits.md#docs/nope.md#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "限界の文書が無いと落ちる"
assert_contains "$ENGINE_OUT" "missing-limits-doc" "無い文書を名指しする"

echo "=== scenario 4: 台帳が読めない・数字でないと落ちる ==="
write_registry "$(printf '%s' "$GOOD" | sed 's#scripts/lib/ledger.json#scripts/lib/nope.json#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "台帳が無いと落ちる"
assert_contains "$ENGINE_OUT" "missing-ledger" "無い台帳を名指しする"

write_registry "$(printf '%s' "$GOOD" | sed 's#"path": "pending.length"#"path": "pending"#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "数字にならない道で落ちる"
assert_contains "$ENGINE_OUT" "ledger-not-a-number" "数字でないことを名指しする"

echo "=== scenario 5: 検査を 1 つも持たないハーネスは落ちる ==="
write_registry "$(printf '%s' "$GOOD" | sed 's#"checks": \["scripts/check-thing.test.sh"\]#"checks": []#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "検査 0 件で落ちる"
assert_contains "$ENGINE_OUT" "no-checks" "「測る検査が無い」と名指しする"

echo "=== scenario 6: 登録簿を読めていないとき（0 件）は落ちる ==="
printf '{"generatedMarker":"m","output":"docs/map.md","triggers":{},"harnesses":[]}' > "$WORK/registry.json"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "0 件なら落ちる（fail-open 防止）"
assert_contains "$ENGINE_OUT" "1 件も無い" "読めていない疑いだと言う"

echo "=== scenario 8: 印が無い文書で落ちる ==="
write_registry "$GOOD"
printf '# 地図\n\n印が無い\n' > "$WORK/root/docs/map.md"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "印が無ければ落ちる"
assert_contains "$ENGINE_OUT" "印" "印が無いことを言う"

echo "=== scenario 9: 登録簿が無い導入先は対象 0 件で通る ==="
OUT="$(HARNESS_REGISTRY="$WORK/does-not-exist.json" bash "$RENDER" --check 2>&1)"
CODE=$?
assert_eq "$CODE" "0" "登録簿が無ければ黙って通る"
assert_contains "$OUT" "対象 0 件" "対象が無いと言う"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
