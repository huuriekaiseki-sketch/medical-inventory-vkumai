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
  if grep -qF -- "$needle" <<<"$haystack"; then
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

echo "=== scenario 9: git worktreeの中からbefore → 共有logs/の件数が記録され、after側と同じ場所を読む ==="
# WHY: before側だけがcwd相対のlogs/を読み、after側（check-*-gap.sh）と記録側はresolve_log_dirで
# 本体チェックアウトの共有logs/を読んでいた（issue #546の修正がbefore側に当たっていなかった）。
# worktreeではbefore=0・after=全履歴になり、差分がexpectedと一致せず毎回警告が出る＝警告が
# 記録漏れの有無を何も語らなくなる。env上書き（GAP_CHECK_*_LOG / AIDD_LOG_DIR）を使うと
# 既定の解決経路を通らないので、このシナリオだけは使い捨ての実gitリポジトリ＋worktreeで確かめる。
mkdir -p "$WORK_DIR/git-sandbox"
# WHY: pwd -P で実体パスにする。macOSのmktempは/var（/private/varへのsymlink）配下を返し、
# *-gap.js の `import.meta.url === file://argv[1]` 判定がsymlink経由だと一致せず、main()が
# 走らないまま無出力・exit 0 になる（after側のassertが「何も出ない」で落ちて原因を見誤る）
GIT_SANDBOX="$(cd "$WORK_DIR/git-sandbox" && pwd -P)"
MAIN_REPO="$GIT_SANDBOX/main"
LINKED_WT="$GIT_SANDBOX/wt"
mkdir -p "$MAIN_REPO/scripts/lib" "$MAIN_REPO/.claude/workflows/lib"
cp "$SCRIPT" "$SCRIPT_DIR/check-loop-observability-gap.sh" "$SCRIPT_DIR/check-agent-progress-gap.sh" \
  "$MAIN_REPO/scripts/"
cp "$SCRIPT_DIR/lib/resolve-log-dir.sh" "$MAIN_REPO/scripts/lib/"
cp "$SCRIPT_DIR/../.claude/workflows/lib/loop-observability-gap.js" \
  "$SCRIPT_DIR/../.claude/workflows/lib/agent-progress-gap.js" "$MAIN_REPO/.claude/workflows/lib/"
git -C "$MAIN_REPO" init -q
git -C "$MAIN_REPO" add -A
git -C "$MAIN_REPO" -c user.name=test -c user.email=test@example.invalid -c core.hooksPath=/dev/null \
  -c commit.gpgsign=false commit -q -m "sandbox"
git -C "$MAIN_REPO" worktree add -q "$LINKED_WT" -b sandbox-wt

# 共有logs/（本体チェックアウト側）: loop 3行、progressはdone/failedが2件
mkdir -p "$MAIN_REPO/logs"
printf '%s\n%s\n%s\n' '{"a":1}' '{"a":2}' '{"a":3}' > "$MAIN_REPO/logs/loop-observability.jsonl"
printf '%s\n%s\n%s\n' \
  '{"agent":"reviewer","status":"done"}' \
  '{"agent":"reviewer","status":"running"}' \
  '{"agent":"implementer","status":"failed"}' > "$MAIN_REPO/logs/agent-progress.jsonl"
# おとり: worktree直下のlogs/（issue #546以前の死蔵ログに相当）。こちらを読んだら1/1になる
mkdir -p "$LINKED_WT/logs"
printf '%s\n' '{"a":"decoy"}' > "$LINKED_WT/logs/loop-observability.jsonl"
printf '%s\n' '{"agent":"decoy","status":"done"}' > "$LINKED_WT/logs/agent-progress.jsonl"

WT_STATE="$WORK_DIR/wt-state.json"
set +e
WT_OUT="$(env -u AIDD_LOG_DIR -u GAP_CHECK_LOOP_LOG -u GAP_CHECK_PROGRESS_LOG \
  GAP_CHECK_STATE_FILE="$WT_STATE" bash "$LINKED_WT/scripts/record-gap-check-state.sh" before 2>&1)"
WT_EXIT=$?
set -e
assert_eq "$WT_EXIT" "0" "worktree内のbeforeがexit 0"
WT_BEFORE_LOOP="$(jq -r '.beforeLoopObservability // "null"' "$WT_STATE")"
WT_BEFORE_PROGRESS="$(jq -r '.beforeAgentProgress // "null"' "$WT_STATE")"
assert_eq "$WT_BEFORE_LOOP" "3" "共有logs/のloop行数=3（worktree直下のおとり=1ではない）"
assert_eq "$WT_BEFORE_PROGRESS" "2" "共有logs/のdone/failed=2（worktree直下のおとり=1ではない）"

# before側とafter側が同じ場所を読むなら、何も足していない時点の差分は0のはず（expected 0でgap無し）。
# 片方の解決だけが変わる食い違いが再発すると、ここが hasGap:true で落ちる
# WHY: after側はcdしないので resolve_log_dir は呼び出し時のcwdのgitリポジトリを見る（実運用では
# Stop hookがプロジェクトルートへcdしてから呼ぶ）。cwdをサンドボックスのworktreeにしないと、
# テストを起動した本物のリポジトリのlogs/を読んでしまう
set +e
WT_LOOP_GAP="$(cd "$LINKED_WT" && env -u AIDD_LOG_DIR bash scripts/check-loop-observability-gap.sh \
  --before "$WT_BEFORE_LOOP" --expected 0 2>&1)"
WT_PROGRESS_GAP="$(cd "$LINKED_WT" && env -u AIDD_LOG_DIR bash scripts/check-agent-progress-gap.sh \
  --before "$WT_BEFORE_PROGRESS" --expected 0 2>&1)"
set -e
assert_contains "$WT_LOOP_GAP" '"hasGap":false' "before直後のloop-observability差分が0（beforeとafterが同じログを読む）"
assert_contains "$WT_PROGRESS_GAP" '"hasGap":false' "before直後のagent-progress差分が0（beforeとafterが同じログを読む）"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
