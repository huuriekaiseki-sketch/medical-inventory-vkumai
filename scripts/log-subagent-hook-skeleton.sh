#!/usr/bin/env bash
set -euo pipefail

# SubagentStart/SubagentStop hook（settings.jsonに登録）から標準入力でJSONペイロードを受け取り、
# logs/subagent-skeleton.jsonlへ「骨格」記録（agent_id・agent_type・開始/終了・timestamp）を
# 機械的に追記する(issue #423)。
#
# 背景: log-agent-progress.sh / log-loop-observability.sh はエージェントへの自然言語指示に
# 依存しており、呼び忘れると記録が丸ごと欠落する（実際に2026-07-07以降5日分欠落した実績あり）。
# hookはLLMが実行を選ぶことに頼らず決定論的に実行されるため、呼び忘れという故障モード自体が
# 構造的に発生しなくなる。issue #423のステップ1実験で、通常のAgent tool経由・Workflowの
# agent()呼び出し経由の両方でSubagentStart/SubagentStopが発火することを確認済み。
#
# 注意（スコープ）: ここで記録するのは「骨格」のみ（agent_id・agent_type・開始/終了時刻・
# 完了時の最終アシスタントメッセージ）。feature/intent/scenario等の意味情報は引き続き
# log-agent-progress.sh / log-loop-observability.sh の自己申告に委ねる（保証レベル3層の
# うち①のみを機械強制する。詳細はdocs/agents/common.md参照）。
#
# ペイロードにstatus（pass/fail/blocked）フィールドは含まれないため、pass/fail/blockedの
# 意味判定はここでは行わない。「SubagentStopが発火した」という事実のみが「エージェントが
# 完了処理まで到達した」ことの機械的な証拠になる。

LOG_FILE="${SUBAGENT_HOOK_SKELETON_LOG_FILE:-logs/subagent-skeleton.jsonl}"

PAYLOAD="$(cat)"

HOOK_EVENT="$(echo "$PAYLOAD" | jq -r '.hook_event_name // empty')"
SESSION_ID="$(echo "$PAYLOAD" | jq -r '.session_id // empty')"
AGENT_ID="$(echo "$PAYLOAD" | jq -r '.agent_id // empty')"
AGENT_TYPE="$(echo "$PAYLOAD" | jq -r '.agent_type // empty')"
AGENT_TRANSCRIPT_PATH="$(echo "$PAYLOAD" | jq -r '.agent_transcript_path // empty')"
LAST_ASSISTANT_MESSAGE="$(echo "$PAYLOAD" | jq -r '.last_assistant_message // empty')"

if [[ -z "$HOOK_EVENT" || -z "$AGENT_ID" ]]; then
  # ペイロード形状が想定と異なる場合はサイレントに何もしない(hookの失敗でセッション全体を
  # 止めないため。exit非0にするとhook自体がエラー扱いになりうる)。
  exit 0
fi

mkdir -p "$(dirname "$LOG_FILE")"

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

jq -nc \
  --arg timestamp "$TIMESTAMP" \
  --arg hookEvent "$HOOK_EVENT" \
  --arg sessionId "$SESSION_ID" \
  --arg agentId "$AGENT_ID" \
  --arg agentType "$AGENT_TYPE" \
  --arg agentTranscriptPath "$AGENT_TRANSCRIPT_PATH" \
  --arg lastAssistantMessage "$LAST_ASSISTANT_MESSAGE" \
  '{
    timestamp: $timestamp,
    hookEvent: $hookEvent,
    sessionId: $sessionId,
    agentId: $agentId,
    agentType: $agentType
  }
  + (if $agentTranscriptPath != "" then {agentTranscriptPath: $agentTranscriptPath} else {} end)
  + (if $lastAssistantMessage != "" then {lastAssistantMessage: $lastAssistantMessage} else {} end)' \
  >> "$LOG_FILE"

exit 0
