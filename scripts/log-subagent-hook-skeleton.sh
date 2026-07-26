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
#
# issue #423ステップ3: agent()のopts.labelはペイロードに含まれないため、呼び出し側
# （aidd-phase2.js）はプロンプト本文の先頭に「INTENT: <label> feature=<feature>」という
# 規約行を埋め込む。ここではagent_transcript_pathが指すtranscriptファイルをテキストとして
# grepし、規約行を抽出できた場合のみベストエフォートでintentフィールドに追記する
# （②feature/attempt層。抽出できなくてもhook自体は失敗させない＝欠落は許容する）。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="${SUBAGENT_HOOK_SKELETON_LOG_FILE:-$(resolve_log_dir)/subagent-skeleton.jsonl}"

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

# INTENT規約行の抽出（ベストエフォート）。transcriptはJSONL（1行1エントリ）だが、規約行
# `INTENT: <label> feature=<feature>` は通常のASCII文字のみで構成されるためJSON文字列内でも
# エスケープされずそのまま現れる。厳密なJSON構造のパースは行わず、テキストとして最初の
# 一致だけを取り出す（transcriptの正確なスキーマに依存しないための割り切り）。
INTENT_LINE=""
if [[ -n "$AGENT_TRANSCRIPT_PATH" && -f "$AGENT_TRANSCRIPT_PATH" ]]; then
  INTENT_LINE="$(grep -m 1 -oE 'INTENT: [^"\\]+' "$AGENT_TRANSCRIPT_PATH" 2>/dev/null || true)"
fi
INTENT_VALUE="${INTENT_LINE#INTENT: }"

jq -nc \
  --arg timestamp "$TIMESTAMP" \
  --arg hookEvent "$HOOK_EVENT" \
  --arg sessionId "$SESSION_ID" \
  --arg agentId "$AGENT_ID" \
  --arg agentType "$AGENT_TYPE" \
  --arg agentTranscriptPath "$AGENT_TRANSCRIPT_PATH" \
  --arg lastAssistantMessage "$LAST_ASSISTANT_MESSAGE" \
  --arg intentValue "$INTENT_VALUE" \
  '{
    timestamp: $timestamp,
    hookEvent: $hookEvent,
    sessionId: $sessionId,
    agentId: $agentId,
    agentType: $agentType
  }
  + (if $agentTranscriptPath != "" then {agentTranscriptPath: $agentTranscriptPath} else {} end)
  + (if $lastAssistantMessage != "" then {lastAssistantMessage: $lastAssistantMessage} else {} end)
  + (if $intentValue != "" then {intent: $intentValue} else {} end)' \
  >> "$LOG_FILE"

exit 0
