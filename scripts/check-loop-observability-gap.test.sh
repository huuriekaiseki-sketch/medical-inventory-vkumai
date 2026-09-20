#!/bin/bash
# WHY(issue #812): gap check は loop-observability.jsonl の**総行数の差**で「フローの記録が何件増えたか」を
# 数えていた。ところが同じログには E2E の実行も 1 テストごとに 1 行書く
# （E2E の reporter。agent=e2e-runner）。フロー中に E2E が 1 回走ると
# 100 行前後が上乗せされる。判定は actual !== expected なので**必ず警告になり**、その警告が
# 記録漏れなのか E2E の雑音なのかを読み分けられない（actual の数字が漏れの件数を表さなくなる）。
# 毎回鳴る警告は読まれなくなる。
# 2026-09-20 の実測: issue #809 の実装フローで actual=140 / expected=21、うち 116 行が E2E だった。
#
# このテストは before（record-gap-check-state.sh）と after（check-loop-observability-gap.sh）を
# **本物のスクリプトで**通す。check-gap-check-state.test.sh は after をモックに差し替えているので、
# 数え方そのものは今までどのテストも通っていなかった。
#
# 実行: bash scripts/check-loop-observability-gap.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECORD="$SCRIPT_DIR/record-gap-check-state.sh"
CHECK="$SCRIPT_DIR/check-loop-observability-gap.sh"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

fail=0
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}

flow_line() { printf '{"agent":"%s","feature":"f","loop":"%s","result":"pass"}\n' "$1" "$2"; }
e2e_line() { printf '{"agent":"e2e-runner","feature":"e2e","loop":"developer","result":"pass"}\n'; }

# $1=ログ $2=state → before を記録し、その値を返す
record_before() {
  GAP_CHECK_LOOP_LOG="$1" GAP_CHECK_PROGRESS_LOG="$WORKDIR/no-progress.jsonl" GAP_CHECK_STATE_FILE="$2" \
    bash "$RECORD" before >/dev/null
  jq -r '.beforeLoopObservability' "$2"
}

# $1=ログ $2=before $3=expected → 判定の JSON を返す（gap ありは exit 1 なので握る）
run_check() {
  bash "$CHECK" --before "$2" --expected "$3" --log-file "$1" 2>/dev/null || true
}

echo "=== scenario 1: フロー中に E2E が走っても、フローの記録が揃っていれば gap なし ==="
LOG="$WORKDIR/s1.jsonl"
for _ in 1 2 3; do flow_line reviewer developer; done > "$LOG"
for _ in 1 2 3 4 5; do e2e_line; done >> "$LOG"
BEFORE="$(record_before "$LOG" "$WORKDIR/s1-state.json")"
assert_eq "$BEFORE" "3" "before は E2E の行を数えない（8 行中フローの 3 行）"
for _ in 1 2; do flow_line implementer agentic; done >> "$LOG"
flow_line reviewer developer >> "$LOG"
for _ in $(seq 1 40); do e2e_line; done >> "$LOG"
OUT="$(run_check "$LOG" "$BEFORE" 3)"
assert_eq "$(jq -r '.actualCount' <<<"$OUT")" "3" "actual はフローの 3 件（E2E の 40 行を足さない）"
assert_eq "$(jq -r '.hasGap' <<<"$OUT")" "false" "gap なし"

echo "=== scenario 2: E2E が大量に走っていても、漏れの件数が正しく読める ==="
# WHY: 総行数で数えると actual=41 になる。警告は出るが「38 件多い」と読めてしまい、
#      実際は 2 件足りないことが数字から分からない
LOG="$WORKDIR/s2.jsonl"
flow_line reviewer developer > "$LOG"
BEFORE="$(record_before "$LOG" "$WORKDIR/s2-state.json")"
flow_line implementer agentic >> "$LOG"
for _ in $(seq 1 40); do e2e_line; done >> "$LOG"
OUT="$(run_check "$LOG" "$BEFORE" 3)"
assert_eq "$(jq -r '.actualCount' <<<"$OUT")" "1" "actual は 1 件（期待 3 件に 2 件足りない）"
assert_eq "$(jq -r '.hasGap' <<<"$OUT")" "true" "gap あり"

echo "=== scenario 3: reviewer の記録は loop=developer でも数える（loop で絞ると落ちる） ==="
# WHY: 実測で reviewer の記録は E2E と同じ loop=developer だった。loop=agentic だけ数える直し方は
#      reviewer の 13 件を落とし、今度は少なすぎる側に振れる（issue #812 のコメント）
LOG="$WORKDIR/s3.jsonl"
: > "$LOG"
BEFORE="$(record_before "$LOG" "$WORKDIR/s3-state.json")"
for _ in 1 2 3 4; do flow_line reviewer developer; done >> "$LOG"
OUT="$(run_check "$LOG" "$BEFORE" 4)"
assert_eq "$(jq -r '.actualCount' <<<"$OUT")" "4" "reviewer（developer ループ）の 4 件を数える"
assert_eq "$(jq -r '.hasGap' <<<"$OUT")" "false" "gap なし"

echo "=== scenario 4: 読めない行は黙って捨てず、フローの記録として数える ==="
# WHY: JSON として読めない行を 0 件扱いにすると、ログが壊れたときに「漏れ」ではなく「静かに少ない」になる。
#      誰が書いたか分からない行は、除外せず数える側に倒す（総行数で数えていた従来と同じ向き）
LOG="$WORKDIR/s4.jsonl"
: > "$LOG"
BEFORE="$(record_before "$LOG" "$WORKDIR/s4-state.json")"
flow_line implementer agentic >> "$LOG"
echo 'this is not json' >> "$LOG"
e2e_line >> "$LOG"
OUT="$(run_check "$LOG" "$BEFORE" 2)"
assert_eq "$(jq -r '.actualCount' <<<"$OUT")" "2" "読めない 1 行も数える（E2E の 1 行は数えない）"

echo "=== scenario 5: before と after が同じ数え方をしている（片方だけ直すと差が狂う） ==="
# WHY: PR #804 で踏んだ型。before と after が別々の場所・別々の数え方を持つと、差は決して合わない
LOG="$WORKDIR/s5.jsonl"
for _ in 1 2; do flow_line reviewer developer; done > "$LOG"
for _ in $(seq 1 30); do e2e_line; done >> "$LOG"
BEFORE="$(record_before "$LOG" "$WORKDIR/s5-state.json")"
OUT="$(run_check "$LOG" "$BEFORE" 0)"
assert_eq "$(jq -r '.actualCount' <<<"$OUT")" "0" "何も足していなければ、E2E が何行あっても差は 0"

echo "=== scenario 6: 除く書き手の一覧は 1 か所（集計側と同じものを読む） ==="
LIST="$SCRIPT_DIR/lib/non-subagent-loop-agents.json"
assert_eq "$([ -f "$LIST" ] && echo yes || echo no)" "yes" "一覧のファイルがある"
assert_eq "$(jq -c '.agents | sort' "$LIST" 2>/dev/null || echo missing)" '["e2e-runner","human"]' "一覧は human と e2e-runner"
# WHY(対象が無ければ見ない): 集計スクリプトは配布物に入っていない。配られた先でこの検査が
#      「自前の一覧を持っている」と落ちるのは、無い問題を追いかけさせる（C-048 / C-025）
AGGREGATE="$SCRIPT_DIR/lib/aggregate-loop-observability-usage.ts"
if [ ! -f "$AGGREGATE" ]; then
  echo "  SKIP: 集計スクリプトがこの木に無い（配布先）。一覧の共有は見ない"
elif grep -qF "non-subagent-loop-agents.json" "$AGGREGATE"; then
  echo "  OK: 集計側（aggregate-loop-observability-usage.ts）も同じ一覧を読む"
else
  echo "  NG: 集計側が自前の一覧を持っている（2 か所に散っている）"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
