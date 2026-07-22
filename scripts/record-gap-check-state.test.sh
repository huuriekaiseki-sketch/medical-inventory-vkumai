#!/bin/bash
# WHY: scripts/record-gap-check-state.sh（issue #488のgap check state記録側）の回帰テスト。
# 実ログ・実stateファイルに依存させず、一時ディレクトリのフェイクログ・stateパスを
# 環境変数で注入して決定的に検証する（check-blocked-issues-staleness.test.shと同じパターン）。
#
# 実行: bash scripts/record-gap-check-state.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/record-gap-check-state.sh"

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
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  OK: $label"
  else
    echo "  NG: $label"
    echo "      expected to find: $needle"
    echo "      actual: $haystack"
    fail=1
  fi
}

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

STATE="$WORK_DIR/state.json"
LOOP_LOG="$WORK_DIR/loop.jsonl"
PROGRESS_LOG="$WORK_DIR/progress.jsonl"

run_record() {
  set +e
  OUT="$(GAP_CHECK_STATE_FILE="$STATE" GAP_CHECK_LOOP_LOG="$LOOP_LOG" \
    GAP_CHECK_PROGRESS_LOG="$PROGRESS_LOG" GAP_CHECK_NOW_EPOCH=1000000 \
    bash "$SCRIPT" "$@" 2>&1)"
  EXIT_CODE=$?
  set -e
}

state_field() {
  jq -r "$1 // \"null\"" "$STATE"
}

echo "=== scenario 1: ログが存在しない状態でbefore → 0/0が記録される ==="
run_record before
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_eq "$(state_field '.beforeLoopObservability')" "0" "beforeLoopObservability=0"
assert_eq "$(state_field '.beforeAgentProgress')" "0" "beforeAgentProgress=0"
assert_eq "$(state_field '.recordedAt')" "1000000" "recordedAtが注入した時刻"

echo "=== scenario 2: フェイクログがある状態でbefore → 実件数が記録される ==="
rm -f "$STATE"
printf '%s\n%s\n%s\n' '{"a":1}' '{"a":2}' '{"a":3}' > "$LOOP_LOG"
printf '%s\n%s\n%s\n' \
  '{"agent":"reviewer","status":"done"}' \
  '{"agent":"reviewer","status":"running"}' \
  '{"agent":"implementer","status":"failed"}' > "$PROGRESS_LOG"
run_record before
assert_eq "$(state_field '.beforeLoopObservability')" "3" "loop行数=3"
assert_eq "$(state_field '.beforeAgentProgress')" "2" "done/failedのみカウント=2"

echo "=== scenario 3: before二重実行 → first-write-winsで上書きされない ==="
printf '%s\n' '{"a":4}' >> "$LOOP_LOG"
run_record before
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "上書きしません" "first-write-winsのメッセージ"
assert_eq "$(state_field '.beforeLoopObservability')" "3" "before値が変わっていない"

echo "=== scenario 4: expected加算 → 複数回呼び出しで合算される ==="
run_record expected --agent-progress 4
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_eq "$(state_field '.expectedAgentProgress')" "4" "1回目: agentProgress=4"
assert_eq "$(state_field '.expectedLoopObservability')" "null" "未指定のloopObservabilityはフィールド自体が作られない"
run_record expected --loop-observability 10 --agent-progress 12
assert_eq "$(state_field '.expectedAgentProgress')" "16" "2回目: 4+12=16"
assert_eq "$(state_field '.expectedLoopObservability')" "10" "loopObservability=10"
assert_eq "$(state_field '.beforeLoopObservability')" "3" "before値は保持される"

echo "=== scenario 5: before未記録でexpected → exit 1 ==="
rm -f "$STATE"
run_record expected --agent-progress 4
assert_eq "$EXIT_CODE" "1" "exit 1"
assert_contains "$OUT" "before値が未記録" "手順逸脱のエラーメッセージ"

echo "=== scenario 6: 引数なしexpected / 不明サブコマンド → usage(exit 1) ==="
run_record before
run_record expected
assert_eq "$EXIT_CODE" "1" "expected引数なしはexit 1"
run_record unknown-subcommand
assert_eq "$EXIT_CODE" "1" "不明サブコマンドはexit 1"

echo "=== scenario 7: フラグの値渡し忘れ → 生のunboundエラーではなく検証エラー(exit 1) ==="
run_record expected --agent-progress
assert_eq "$EXIT_CODE" "1" "値なし--agent-progressはexit 1"
assert_contains "$OUT" "値が不正" "検証エラーメッセージが出る（unbound variableではない）"

echo "=== scenario 8: 非数値の値 → 検証エラー(exit 1)・stateは変更されない ==="
BEFORE_STATE="$(cat "$STATE")"
run_record expected --loop-observability abc
assert_eq "$EXIT_CODE" "1" "非数値はexit 1"
assert_contains "$OUT" "値が不正" "検証エラーメッセージが出る（生のjqエラーではない）"
assert_eq "$(cat "$STATE")" "$BEFORE_STATE" "stateファイルが変更されていない"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
