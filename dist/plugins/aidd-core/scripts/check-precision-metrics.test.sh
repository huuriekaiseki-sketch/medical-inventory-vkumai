#!/usr/bin/env bash
# WHY(2026-09-10、レビューの設計提案 3): 精度指標のまとめ（scripts/show-precision-metrics.sh）の
#      回帰テスト。この道具が壊れると、**測れなかったことが測れたことに見える**か、
#      **振れている指標が安定して見える**——どちらも「数字はあるのに読めない」状態になる。
#
#      固定するのは 3 つ:
#        (a) 測れなかった件数を**分母から消さない**（18/18 に見せない）
#        (b) 同条件のばらつきを出す（1 回の実行を合否に使ってよいかの判断材料）
#        (c) 一度も測っていない指標を、0% とも 100% とも言わない
#
# 実行: bash scripts/check-precision-metrics.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENGINE="$SCRIPT_DIR/lib/precision-metrics.mjs"
SHOW="$SCRIPT_DIR/show-precision-metrics.sh"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
assert_contains() {
  if printf '%s' "$1" | grep -qF -- "$2"; then ok "$3"; else
    ng "$3" "期待: $2"; echo "      実際: $1"; fi
}
assert_not_contains() {
  if printf '%s' "$1" | grep -qF -- "$2"; then ng "$3" "出てはいけない: $2"; else ok "$3"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/root/logs" "$WORK/root/docs/agents"

run_engine() { # $@ = 追加の引数
  ENGINE_OUT="$(node "$ENGINE" "$WORK/registry.json" --root "$WORK/root" "$@" 2>&1)"
  ENGINE_CODE=$?
}

echo "=== scenario 1: 実物の登録簿で出力が出る ==="
OUT="$(bash "$SHOW" 2>&1)"
CODE=$?
if [ "$CODE" -eq 0 ]; then ok "exit 0"; else ng "exit ${CODE}" "$OUT"; fi
assert_contains "$OUT" "変異撃破率" "役割別の見出しが出る"
assert_contains "$OUT" "限界" "限界を必ず出す"

echo "=== scenario 2: 測れなかった件数を分母から消さない ==="
# WHY: 2026-09-10 まで RLS の変異計測は「倒した / (倒した+生き残り)」で数えており、
#      **測れなかった分が分母からも消えて**「18/18」に見えていた
cat > "$WORK/registry.json" <<'JSON'
{
  "metrics": [
    { "id": "PM-001", "name": "変異", "kind": "変異撃破率", "role": "H-06",
      "log": "logs/m.jsonl", "numerator": "killed", "denominator": "targeted", "unmeasured": "errors" }
  ]
}
JSON
printf '{"at":"2026-01-01T00:00:00Z","killed":15,"targeted":18,"errors":3}\n' > "$WORK/root/logs/m.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "15 / 18" "分母は対象件数のまま（15/15 に見せない）"
assert_contains "$ENGINE_OUT" "測れなかった 3 件を分母に残している" "測れなかった件数を名指しする"
assert_not_contains "$ENGINE_OUT" "15 / 15" "測れなかった分を分母から消さない"

echo "=== scenario 2b: 状態の語で数えるときも、測れなかったを分母から消さない ==="
# WHY(2026-09-10): scenario 2 は「分子・分母・測れなかった」を数で持つ指標だけを通しており、
#      **状態の語（pass / fail / unmeasured / skipped）で数える経路を一度も通っていなかった**。
#      変異計測（CM-032）がその未通過の経路を見つけた——テストが緑でも守っていない典型。
cat > "$WORK/registry.json" <<'JSON'
{
  "metrics": [
    { "id": "PM-003", "name": "実行可能", "kind": "実行可能率", "role": "H-02",
      "log": "logs/s.jsonl", "stateField": "dataGuardResult",
      "measuredStates": ["pass", "fail"], "unmeasuredStates": ["unmeasured", "skipped"] }
  ]
}
JSON
{
  printf '{"at":"2026-01-01T00:00:00Z","dataGuardResult":"pass"}\n'
  printf '{"at":"2026-01-02T00:00:00Z","dataGuardResult":"skipped"}\n'
  printf '{"at":"2026-01-03T00:00:00Z","dataGuardResult":"unmeasured"}\n'
} > "$WORK/root/logs/s.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "1 / 3" "測れた 1 件・分母は 3 件（1/1 に見せない）"
assert_contains "$ENGINE_OUT" "測れなかった 2 件を分母に残している" "測れなかった件数を名指しする"
assert_not_contains "$ENGINE_OUT" "1 / 1" "測れなかった分を分母から消さない"

# 対照: 測れなかったが 0 件なら、そう言う
printf '{"at":"2026-01-01T00:00:00Z","dataGuardResult":"pass"}\n' > "$WORK/root/logs/s.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "測れなかった 0 件" "全部測れたときは 0 件と言う（対照）"

echo "=== scenario 3: 同条件のばらつきを出す ==="
cat > "$WORK/registry.json" <<'JSON'
{
  "metrics": [
    { "id": "PM-001", "name": "変異", "kind": "変異撃破率", "role": "H-06",
      "log": "logs/m.jsonl", "numerator": "killed", "denominator": "targeted", "unmeasured": "errors" }
  ]
}
JSON
# WHY: 1 回の実行を合否に使うと、モデルの揺れを仕組みの劣化と読み違える
{
  printf '{"at":"2026-01-01T00:00:00Z","killed":18,"targeted":18,"errors":0}\n'
  printf '{"at":"2026-01-02T00:00:00Z","killed":9,"targeted":18,"errors":0}\n'
} > "$WORK/root/logs/m.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "振れている" "同じ条件で結果が違えば振れていると言う"
assert_contains "$ENGINE_OUT" "50% 〜 100%" "幅を数字で出す"
assert_contains "$ENGINE_OUT" "1 回の実行を合否に使えない" "何を意味するかを書く"

{
  printf '{"at":"2026-01-01T00:00:00Z","killed":18,"targeted":18,"errors":0}\n'
  printf '{"at":"2026-01-02T00:00:00Z","killed":18,"targeted":18,"errors":0}\n'
} > "$WORK/root/logs/m.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "安定" "同じ結果が続けば安定と言う（対照）"
# 総括行にも「振れている指標は無い」という文字列が出るので、**指標の行**だけを見る
assert_not_contains "$ENGINE_OUT" '**振れている**）' "安定しているものを振れていると言わない"
assert_contains "$ENGINE_OUT" "振れている指標は無い" "総括でも振れていないと言う"

echo "=== scenario 3b: 条件が違う回を同じばらつきに混ぜない（設計提案 3「再現性」） ==="
# WHY(2026-09-10): 条件を確かめずにばらつきを出すと、**モデルの揺れ**と
#      **その間にコードが変わっただけ**を区別できない。区別できない数字は判断に使えない。
#      実際、この道具を作った直後は日をまたいだ記録を並べて「4 件が振れている」と出していたが、
#      条件を見るようにしたら比べられる回が 1 回ずつしか無かった（=根拠として不十分だった）。
cat > "$WORK/registry.json" <<'JSON'
{
  "metrics": [
    { "id": "PM-004", "name": "変異", "kind": "変異撃破率", "role": "H-06",
      "log": "logs/m.jsonl", "numerator": "killed", "denominator": "targeted", "unmeasured": "errors",
      "conditionFields": ["srcTree"] }
  ]
}
JSON
# いちばん新しい回と**同じ木**の回だけを比べる。古い木の回は外す
{
  printf '{"at":"2026-01-01T00:00:00Z","killed":9,"targeted":18,"errors":0,"srcTree":"OLD"}\n'
  printf '{"at":"2026-01-02T00:00:00Z","killed":18,"targeted":18,"errors":0,"srcTree":"NEW"}\n'
  printf '{"at":"2026-01-03T00:00:00Z","killed":18,"targeted":18,"errors":0,"srcTree":"NEW"}\n'
} > "$WORK/root/logs/m.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "同じ条件の直近 2 回" "同じ木の回だけを数える"
assert_contains "$ENGINE_OUT" "条件が違う（または条件が記録に無い）1 回は比較から外した" "外した回数を隠さない"
assert_not_contains "$ENGINE_OUT" '**振れている**）' "古い木の 50% を混ぜて振れていると言わない"

# 同じ木の中で結果が違えば、それは本当に振れている
{
  printf '{"at":"2026-01-02T00:00:00Z","killed":18,"targeted":18,"errors":0,"srcTree":"NEW"}\n'
  printf '{"at":"2026-01-03T00:00:00Z","killed":9,"targeted":18,"errors":0,"srcTree":"NEW"}\n'
} > "$WORK/root/logs/m.jsonl"
run_engine
assert_contains "$ENGINE_OUT" '**振れている**）' "同じ木の中で違えば振れていると言う（対照）"

# 条件の欄を持たない古い記録しか無ければ、比べずに 1 回として扱う
{
  printf '{"at":"2026-01-01T00:00:00Z","killed":9,"targeted":18,"errors":0}\n'
  printf '{"at":"2026-01-02T00:00:00Z","killed":18,"targeted":18,"errors":0}\n'
} > "$WORK/root/logs/m.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "同じ条件の回が 1 回" "条件が分からない回どうしは比べない"
assert_not_contains "$ENGINE_OUT" '**振れている**）' "条件が分からないものを振れていると言わない"

echo "=== scenario 3c: 所要時間とモデルを出す（設計提案 3「再現性と費用」の時間の側） ==="
printf '{"at":"2026-01-02T00:00:00Z","killed":18,"targeted":18,"errors":0,"srcTree":"NEW","elapsedSeconds":42,"model":"haiku"}\n' > "$WORK/root/logs/m.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "42 秒" "所要時間を出す"
assert_contains "$ENGINE_OUT" "モデル haiku" "どのモデルで測ったかを出す"
assert_not_contains "$ENGINE_OUT" "\$0.0000" "費用の記録が無い回を 0 円と言わない"

echo "=== scenario 3d: 費用を出す（設計提案 3「再現性と費用」の費用の側） ==="
# WHY(2026-09-10): 費用は `claude -p --output-format json` の `total_cost_usd` から取る。
#      取れた回と取れなかった回を**別々に**出さないと、モックで回した回を 0 円として混ぜてしまい
#      費用が実際より安く見える（C-025: 別々の状態を 1 つに潰す）。
printf '{"at":"2026-01-03T00:00:00Z","killed":18,"targeted":18,"errors":0,"srcTree":"NEW","costUsd":0.0755,"inputTokens":40,"outputTokens":292,"usageSamples":2}\n' > "$WORK/root/logs/m.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "\$0.0755" "費用を金額で出す"
assert_contains "$ENGINE_OUT" "入力 40 / 出力 292 トークン" "トークン数を出す"
assert_contains "$ENGINE_OUT" "2 回分" "何回分の合計かを言う"

echo "=== scenario 3d-2: キャッシュから読んだ入力を並べて出す ==="
# WHY(2026-09-10): `usage.input_tokens` はキャッシュから読んだ分を含まない。実物の 1 回は
#      入力 6 / キャッシュ読み 17,547 だった。入力だけ出すと**プロンプトが 6 トークンだったように読める**。
#      価格が違うので合算はしない（足すと別の嘘になる）。
printf '{"at":"2026-01-03T00:00:00Z","killed":18,"targeted":18,"errors":0,"srcTree":"NEW","costUsd":0.1604,"inputTokens":6,"outputTokens":465,"cacheReadTokens":17547,"usageSamples":1}\n' > "$WORK/root/logs/m.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "うちキャッシュ読み 17547" "キャッシュから読んだ入力を出す"
assert_not_contains "$ENGINE_OUT" "入力 17553" "キャッシュ分を入力に足さない（価格が違う）"

echo "=== scenario 3d-3: 費用にも幅を出す（1 回の金額を予算に使わない） ==="
# WHY(2026-09-10): 実物を同じ条件で 2 回回したら、合否は 1/1 のまま費用が
#      $0.1604 → $0.0519（約 3 倍）に振れた（キャッシュから読めた量の差）。
#      最新 1 回の金額だけ出すと、この道具自身の「1 回の実行を合否に使わない」原則と食い違う。
{
  printf '{"at":"2026-01-04T00:00:00Z","killed":18,"targeted":18,"errors":0,"srcTree":"NEW","costUsd":0.0519,"inputTokens":6,"outputTokens":664,"usageSamples":1}\n'
  printf '{"at":"2026-01-03T00:00:00Z","killed":18,"targeted":18,"errors":0,"srcTree":"NEW","costUsd":0.1604,"inputTokens":6,"outputTokens":465,"usageSamples":1}\n'
} > "$WORK/root/logs/m.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "同条件 2 回で \$0.0519 〜 \$0.1604" "同じ条件の回の費用の幅を出す"

# 対照: 同じ条件の費用が 1 回しか無ければ幅を出さない（1 回を幅と言わない）
printf '{"at":"2026-01-03T00:00:00Z","killed":18,"targeted":18,"errors":0,"srcTree":"NEW","costUsd":0.1604,"inputTokens":6,"outputTokens":465,"usageSamples":1}\n' > "$WORK/root/logs/m.jsonl"
run_engine
assert_not_contains "$ENGINE_OUT" "同条件 1 回で" "1 回しか無いものを幅と言わない（対照）"

echo "=== scenario 3e: 取れなかった回を 0 円と言わない（対照） ==="
printf '{"at":"2026-01-03T00:00:00Z","killed":18,"targeted":18,"errors":0,"srcTree":"NEW","usageMissing":3}\n' > "$WORK/root/logs/m.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "費用は取れなかった（3 回" "取れなかったことをそのまま言う"
assert_not_contains "$ENGINE_OUT" "\$0.0000" "取れなかった回を 0 円に潰さない"

echo "=== scenario 3f: 取れた回と取れなかった回が混ざったら、両方を出す ==="
# WHY: 「$0.05・1 回分」だけ出すと、**残り 4 回ぶんの費用が無かったように見える**
printf '{"at":"2026-01-03T00:00:00Z","killed":18,"targeted":18,"errors":0,"srcTree":"NEW","costUsd":0.05,"inputTokens":10,"outputTokens":20,"usageSamples":1,"usageMissing":4}\n' > "$WORK/root/logs/m.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "1 回分" "取れた回数を出す"
assert_contains "$ENGINE_OUT" "取れなかった 4 回は含まない" "取れなかった回があることを隠さない"

echo "=== scenario 4: 一度も測っていない指標は 0% とも 100% とも言わない ==="
cat > "$WORK/registry.json" <<'JSON'
{
  "metrics": [
    { "id": "PM-001", "name": "変異", "kind": "変異撃破率", "role": "H-06",
      "log": "logs/m.jsonl", "numerator": "killed", "denominator": "targeted", "unmeasured": "errors" }
  ]
}
JSON
rm -f "$WORK/root/logs/m.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "一度も測っていない" "記録が無いことをそのまま出す"
assert_not_contains "$ENGINE_OUT" "0 / 0" "測っていないものを数字にしない"

echo "=== scenario 5: 1 回だけの記録では、ばらつきを判定しない ==="
printf '{"at":"2026-01-01T00:00:00Z","killed":18,"targeted":18,"errors":0}\n' > "$WORK/root/logs/m.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "ばらつきは 2 回以上でないと分からない" "判定できないことを安定と言わない"

echo "=== scenario 6: 壊れた行があっても止まらない（読める行だけを使う） ==="
{
  printf 'これは JSON ではない\n'
  printf '{"at":"2026-01-01T00:00:00Z","killed":18,"targeted":18,"errors":0}\n'
} > "$WORK/root/logs/m.jsonl"
run_engine
if [ "$ENGINE_CODE" -eq 0 ]; then ok "壊れた行があっても exit 0"; else ng "壊れた行で落ちる" "$ENGINE_OUT"; fi
assert_contains "$ENGINE_OUT" "18 / 18" "読める行から数字を出す"

echo "=== scenario 7: 別の fixture セットを混ぜない ==="
# WHY: 混ぜると「どの fixture が振れているか」が分からなくなる（C-031: 数える単位が違う）
cat > "$WORK/registry.json" <<'JSON'
{
  "metrics": [
    { "id": "PM-002", "name": "見逃し", "kind": "見逃し率", "role": "H-01",
      "log": "docs/agents/eval-runs.jsonl",
      "filter": { "field": "script", "value": "eval-sweep-recall" },
      "groupBy": "fixtureSet", "numerator": "pass", "denominator": "total" }
  ]
}
JSON
{
  printf '{"timestamp":"2026-01-01T00:00:00Z","script":"eval-sweep-recall","fixtureSet":"a","pass":2,"total":2}\n'
  printf '{"timestamp":"2026-01-02T00:00:00Z","script":"eval-sweep-recall","fixtureSet":"b","pass":0,"total":2}\n'
  printf '{"timestamp":"2026-01-03T00:00:00Z","script":"other","fixtureSet":"a","pass":0,"total":9}\n'
} > "$WORK/root/docs/agents/eval-runs.jsonl"
run_engine
assert_contains "$ENGINE_OUT" "[a]" "fixture セットごとに分ける"
assert_contains "$ENGINE_OUT" "[b]" "もう一方も出す"
assert_not_contains "$ENGINE_OUT" "0 / 9" "別の script の記録を混ぜない"

echo "=== scenario 8: 登録簿に指標が 1 件も無ければ落ちる（fail-open 防止） ==="
printf '{"metrics": []}' > "$WORK/registry.json"
run_engine
if [ "$ENGINE_CODE" -ne 0 ]; then ok "0 件なら落ちる"; else ng "0 件で静かに通る" "$ENGINE_OUT"; fi
assert_contains "$ENGINE_OUT" "1 件も無い" "読めていない疑いだと言う"

echo "=== scenario 9: 登録簿が無い導入先は黙って通る ==="
OUT="$(PRECISION_METRICS_REGISTRY="$WORK/nope.json" bash "$SHOW" 2>&1)"
CODE=$?
if [ "$CODE" -eq 0 ]; then ok "登録簿が無ければ通る"; else ng "落ちる" "$OUT"; fi
assert_contains "$OUT" "対象 0 件" "対象が無いと言う"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
