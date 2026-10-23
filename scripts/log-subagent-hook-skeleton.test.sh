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
  if grep -qF -- "$needle" <<<"$haystack"; then
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

echo "=== scenario 4: agent_transcript_pathにINTENT規約行があればintentフィールドを抽出する（issue #423ステップ3） ==="
TMP_TRANSCRIPT="$(mktemp)"
printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"INTENT: db-impl feature=order-history\\n\\nまずSPEC.mdを読んでください..."}]}}' > "$TMP_TRANSCRIPT"
input="{\"session_id\":\"sess-1\",\"transcript_path\":\"/tmp/t.jsonl\",\"cwd\":\"/repo\",\"prompt_id\":\"p1\",\"permission_mode\":\"acceptEdits\",\"agent_id\":\"agent-abc\",\"agent_type\":\"implementer\",\"hook_event_name\":\"SubagentStop\",\"stop_hook_active\":false,\"agent_transcript_path\":\"$TMP_TRANSCRIPT\",\"last_assistant_message\":\"実験OK\"}"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
LAST_LINE="$(tail -n 1 "$TMP_LOG")"
assert_contains "$LAST_LINE" '"intent":"db-impl feature=order-history"' "intentフィールドが抽出される"
rm -f "$TMP_TRANSCRIPT"

echo "=== scenario 5: INTENT規約行が無いtranscriptではintentフィールドを付けない ==="
TMP_TRANSCRIPT="$(mktemp)"
printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"レビューしてください"}]}}' > "$TMP_TRANSCRIPT"
input="{\"session_id\":\"sess-1\",\"transcript_path\":\"/tmp/t.jsonl\",\"cwd\":\"/repo\",\"prompt_id\":\"p1\",\"permission_mode\":\"acceptEdits\",\"agent_id\":\"agent-abc\",\"agent_type\":\"reviewer\",\"hook_event_name\":\"SubagentStop\",\"stop_hook_active\":false,\"agent_transcript_path\":\"$TMP_TRANSCRIPT\",\"last_assistant_message\":\"指摘なし\"}"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
LAST_LINE="$(tail -n 1 "$TMP_LOG")"
if grep -qF '"intent"' <<<"$LAST_LINE"; then
  echo "  NG: intentフィールドが付与されないこと（実際: ${LAST_LINE}）"
  fail=1
else
  echo "  OK: intentフィールドが付与されない"
fi
rm -f "$TMP_TRANSCRIPT"

# WHY（issue #902）: Claude Code 2.1.271 以降、auto mode の subagent は報告を SubagentHandback ツールで
# 渡し、SubagentStop の last_assistant_message は報告ではない（公式 hooks リファレンス）。2026-10-23 の
# 実測では auto mode の 4 体の SubagentStop 行に lastAssistantMessage が無かった。報告本文を残すには
# PostToolUse(SubagentHandback) の tool_input.message を記録するしかない。6〜9 はその RED fixture。
echo "=== scenario 6: PostToolUse(SubagentHandback) は報告本文を hookEvent=SubagentHandback の行として残す（issue #902） ==="
BEFORE_LINES="$(wc -l < "$TMP_LOG" | tr -d ' ')"
input='{"session_id":"sess-2","transcript_path":"/tmp/t.jsonl","cwd":"/repo","permission_mode":"auto","hook_event_name":"PostToolUse","tool_name":"SubagentHandback","tool_input":{"message":"# 調査レポート\n\n- 結論: 2 本だけ"},"tool_response":{"ok":true},"tool_use_id":"toolu_01","agent_id":"agent-hb1","agent_type":"general-purpose"}'
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
AFTER_LINES="$(wc -l < "$TMP_LOG" | tr -d ' ')"
assert_eq "$AFTER_LINES" "$((BEFORE_LINES + 1))" "1 行だけ増える"
LAST_LINE="$(tail -n 1 "$TMP_LOG")"
assert_contains "$LAST_LINE" '"hookEvent":"SubagentHandback"' "hookEvent は PostToolUse でなく SubagentHandback"
assert_contains "$LAST_LINE" '"sessionId":"sess-2"' "sessionId が記録される"
assert_contains "$LAST_LINE" '"agentId":"agent-hb1"' "agentId が記録される"
assert_contains "$LAST_LINE" '"agentType":"general-purpose"' "agentType が記録される"
assert_contains "$LAST_LINE" '"message":"# 調査レポート\n\n- 結論: 2 本だけ"' "報告本文が message に残る（改行は JSON エスケープのまま）"
assert_contains "$LAST_LINE" '"messageLength":21' "元の文字数が messageLength に残る"
assert_contains "$LAST_LINE" '"timestamp":"' "timestamp が記録される"

echo "=== scenario 7: 長い報告本文は先頭 4,000 文字で切り、元の長さを messageLength に残す ==="
LONG_MESSAGE="$(printf 'a%.0s' $(seq 1 4100))"
input="{\"session_id\":\"sess-2\",\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"SubagentHandback\",\"tool_input\":{\"message\":\"${LONG_MESSAGE}\"},\"agent_id\":\"agent-hb2\",\"agent_type\":\"reviewer\"}"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
LAST_LINE="$(tail -n 1 "$TMP_LOG")"
STORED_LEN="$(printf '%s' "$LAST_LINE" | jq -r '.message | length')"
assert_eq "$STORED_LEN" "4000" "message は 4,000 文字に切られる"
assert_contains "$LAST_LINE" '"messageLength":4100' "切る前の長さが messageLength に残る"
assert_contains "$LAST_LINE" '"messageTruncated":true' "切ったことが messageTruncated に残る"

echo "=== scenario 8: auto mode の SubagentStop（last_assistant_message 無し、2026-10-23 実測の形）は報告本文を残せない ==="
input='{"session_id":"sess-2","transcript_path":"/tmp/t.jsonl","cwd":"/repo","permission_mode":"auto","agent_id":"agent-hb1","agent_type":"general-purpose","hook_event_name":"SubagentStop","stop_hook_active":false,"agent_transcript_path":"/tmp/subagents/agent-hb1.jsonl"}'
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
LAST_LINE="$(tail -n 1 "$TMP_LOG")"
assert_contains "$LAST_LINE" '"hookEvent":"SubagentStop"' "SubagentStop 行自体は残る（骨格は変えない）"
if grep -qF -e '"lastAssistantMessage"' -e '"message"' <<<"$LAST_LINE"; then
  echo "  NG: SubagentStop 行に報告本文が付かないこと（実際: ${LAST_LINE}）"
  fail=1
else
  echo "  OK: SubagentStop だけでは報告本文が残らない（だから scenario 6 の行が要る）"
fi

echo "=== scenario 9: SubagentHandback 以外のツールの PostToolUse では何も書かない ==="
BEFORE_LINES="$(wc -l < "$TMP_LOG" | tr -d ' ')"
input='{"session_id":"sess-2","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls","message":"これは報告ではない"},"tool_response":{"stdout":""},"agent_id":"agent-hb1","agent_type":"general-purpose"}'
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
AFTER_LINES="$(wc -l < "$TMP_LOG" | tr -d ' ')"
assert_eq "$AFTER_LINES" "$BEFORE_LINES" "行数が増えない（Bash の PostToolUse は対象外）"

rm -f "$TMP_LOG"

if [ "$fail" -ne 0 ]; then
  echo "FAIL"
  exit 1
fi
echo "PASS"
