#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、記録が取れなくなっていた（issue #636）。
# ブロックしないスクリプトなので実害は無音のfail-open（記録が残らないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

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
TOOL_NAME="$(echo "$PAYLOAD" | jq -r '.tool_name // empty')"

# WHY（issue #902）: Claude Code 2.1.271 以降、auto mode の subagent は報告を SubagentHandback
# ツールで渡す。SubagentStop の last_assistant_message は「閉じの一言」であって報告ではない
# （公式 hooks リファレンスに明記。2026-10-23 の実測でも auto mode の 4 体の SubagentStop 行に
# lastAssistantMessage が無かった）。報告本文は PostToolUse(SubagentHandback) の
# tool_input.message にしか現れないので、settings.json の PostToolUse に matcher SubagentHandback
# で本スクリプトを登録し、ここで hookEvent "SubagentHandback" の行として残す。
# SubagentStart / SubagentStop の行の形は変えない。
#
# 本文の上限は先頭 4,000 文字。理由: 報告は 1 体で 20,000 文字を超えることがあり（2026-10-23 の
# 実測）、全文を 1 行に積むと共有の jsonl が読めない大きさになる。4,000 文字あれば報告の結論
# （先頭に書かれる）は残り、全文が要るときは同じ agentId の SubagentStop 行の agentTranscriptPath
# を辿れば読める。切ったことは messageTruncated: true と messageLength（元の文字数）で分かる
# ようにする（切ったのに切っていないように見える形を残さない）。
#
# matcher が SubagentHandback に絞られていても、tool_name をここでも見る。将来 matcher を広げた
# 登録が混ざったとき、他のツールの PostToolUse ごとに骨格行が積まれる事故を防ぐため。
HANDBACK_MESSAGE=""
HANDBACK_MESSAGE_LENGTH=0
if [[ "$HOOK_EVENT" == "PostToolUse" ]]; then
  if [[ "$TOOL_NAME" != "SubagentHandback" ]]; then
    exit 0
  fi
  HOOK_EVENT="SubagentHandback"
  # 切り詰めは jq 側で行う（長い本文を bash の引数に載せないため）
  HANDBACK_MESSAGE="$(echo "$PAYLOAD" | jq -r '.tool_input.message // "" | .[:4000]')"
  HANDBACK_MESSAGE_LENGTH="$(echo "$PAYLOAD" | jq -r '.tool_input.message // "" | length')"
fi

# WHY（issue #928）: 下の 2 か所は「呼ばれたが、骨格記録には書かずに終わる」分岐。以前は何も残さなかったので、
# 骨格記録に行が無いとき「hook が呼ばれていない」のか「呼ばれたがここで終わった」のかを区別できなかった
# （2026-11-12 の調査で、web-fetch の subagent の SubagentStart / SubagentStop がどちらなのか決められなかった）。
# 行が無いことを、呼ばれていないことと読まないために、終わった回を別ファイルに 1 行残す。
#
# 別ファイルにする理由: 骨格記録は agentId で Start / Stop を対にして読まれる（snapshot-agent-baseline.sh ほか）。
# agentId の無い Start / Stop の行を同じファイルに混ぜると、読む側の数え方が変わる。骨格記録の行の形は変えない。
#
# 残すのは、届いた payload のキー名と、種類を表す 3 つの値（hook_event_name / session_id / agent_type）だけ。
# 値を丸ごと写さないのは、last_assistant_message 等に本文が入るため（共有の jsonl に本文を積まない）。
# キー名があれば「agent_id の代わりに何が届いたか」を後から調べられる。
#
# 印を書くこと自体の失敗（jq の失敗・書き込み不可）では hook を失敗させない（末尾の || true）。
# 限界: payload が JSON として読めないときは、この分岐より前の jq で落ちるので印は残らない。hook が
# timeout（5 秒）で打ち切られたときも残らない。「印が無い」は「この 2 つの分岐では終わっていない」まで。
DROPPED_LOG_FILE="${LOG_FILE%.jsonl}-dropped.jsonl"
log_dropped() {
  local reason="$1"
  mkdir -p "$(dirname "$DROPPED_LOG_FILE")" 2>/dev/null || true
  echo "$PAYLOAD" | jq -c \
    --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --arg reason "$reason" \
    '{
      timestamp: $timestamp,
      hookEvent: (.hook_event_name // ""),
      sessionId: (.session_id // ""),
      agentType: (.agent_type // ""),
      reason: $reason,
      payloadKeys: keys
    }' >> "$DROPPED_LOG_FILE" 2>/dev/null || true
}

if [[ -z "$HOOK_EVENT" ]]; then
  log_dropped "empty_hook_event"
  exit 0
fi
if [[ -z "$AGENT_ID" && "$HOOK_EVENT" != "SubagentHandback" ]]; then
  # ペイロード形状が想定と異なる場合は骨格記録には何も書かない(hookの失敗でセッション全体を
  # 止めないため。exit非0にするとhook自体がエラー扱いになりうる)。
  # SubagentHandback だけは agent_id が無くても書く。公式 docs は subagent 内の PostToolUse に
  # agent_id が入ると言うが、実機で欠けたときに報告本文ごと静かに消えるより、agentId 空の行が
  # 残って「欠けている」と分かるほうがよい（C-025 の型を避ける）。
  log_dropped "empty_agent_id"
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
  --arg handbackMessage "$HANDBACK_MESSAGE" \
  --argjson handbackMessageLength "$HANDBACK_MESSAGE_LENGTH" \
  '{
    timestamp: $timestamp,
    hookEvent: $hookEvent,
    sessionId: $sessionId,
    agentId: $agentId,
    agentType: $agentType
  }
  + (if $agentTranscriptPath != "" then {agentTranscriptPath: $agentTranscriptPath} else {} end)
  + (if $lastAssistantMessage != "" then {lastAssistantMessage: $lastAssistantMessage} else {} end)
  + (if $intentValue != "" then {intent: $intentValue} else {} end)
  + (if $hookEvent == "SubagentHandback"
     then {message: $handbackMessage, messageLength: $handbackMessageLength}
          + (if $handbackMessageLength > 4000 then {messageTruncated: true} else {} end)
     else {} end)' \
  >> "$LOG_FILE"

exit 0
