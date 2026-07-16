#!/bin/bash
# WHY: issue #423向けのSubagentStart/SubagentStop hook(scripts/log-subagent-hook-skeleton.sh)の回帰テスト。
# 実際のhookペイロード(issue #423ステップ1の実験で観測した実物の形状)を標準入力で渡し、
# logs/subagent-skeleton.jsonl相当の一時ファイルに骨格記録が正しく追記されることを確認する。
#
# 実行: bash scripts/log-subagent-hook-skeleton.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/log-subagent-hook-skeleton.sh"

fail=0
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
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}

TMP_LOG="$(mktemp)"
rm -f "$TMP_LOG"

run_hook() {
  local input="$1"
  set +e
  OUT="$(printf '%s' "$input" | SUBAGENT_HOOK_SKELETON_LOG_FILE="$TMP_LOG" bash "$SCRIPT")"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: SubagentStart ==="
input='{"session_id":"sess-1","transcript_path":"/tmp/t.jsonl","cwd":"/repo","prompt_id":"p1","agent_id":"agent-abc","agent_type":"sweep-ui","hook_event_name":"SubagentStart"}'
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
LAST_LINE="$(tail -n 1 "$TMP_LOG")"
assert_contains "$LAST_LINE" '"hookEvent":"SubagentStart"' "hookEventが記録される"
assert_contains "$LAST_LINE" '"agentId":"agent-abc"' "agentIdが記録される"
assert_contains "$LAST_LINE" '"agentType":"sweep-ui"' "agentTypeが記録される"

echo "=== scenario 2: SubagentStop（通常のAgent tool経由、実観測ペイロード） ==="
input='{"session_id":"sess-1","transcript_path":"/tmp/t.jsonl","cwd":"/repo","prompt_id":"p1","permission_mode":"acceptEdits","agent_id":"agent-abc","agent_type":"sweep-ui","hook_event_name":"SubagentStop","stop_hook_active":false,"agent_transcript_path":"/tmp/subagents/agent-abc.jsonl","last_assistant_message":"実験OK","background_tasks":[],"session_crons":[]}'
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
LAST_LINE="$(tail -n 1 "$TMP_LOG")"
assert_contains "$LAST_LINE" '"hookEvent":"SubagentStop"' "hookEventが記録される"
assert_contains "$LAST_LINE" '"agentTranscriptPath":"/tmp/subagents/agent-abc.jsonl"' "agentTranscriptPathが記録される"
assert_contains "$LAST_LINE" '"lastAssistantMessage":"実験OK"' "lastAssistantMessageが記録される"

echo "=== scenario 3: agent_idが欠落したペイロードは何も書き込まずexit 0 ==="
BEFORE_LINES="$(wc -l < "$TMP_LOG" | tr -d ' ')"
input='{"session_id":"sess-1","hook_event_name":"SubagentStart"}'
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0（サイレント無視）"
AFTER_LINES="$(wc -l < "$TMP_LOG" | tr -d ' ')"
assert_eq "$AFTER_LINES" "$BEFORE_LINES" "行数が増えない（不正ペイロードは書き込まない）"

rm -f "$TMP_LOG"

if [ "$fail" -ne 0 ]; then
  echo "FAIL"
  exit 1
fi
echo "PASS"
