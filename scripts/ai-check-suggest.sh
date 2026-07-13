#!/usr/bin/env bash
set -euo pipefail

# Stop hookから呼ばれる。セッション中にnpm run ai:check相当（typecheck/lint/test/e2e）が
# 実行されたかをtranscriptから機械的に検査し、ソース変更があるのに未実行なら
# systemMessageで警告する（Claude本体のBashツールを経由しないため、非対話環境の
# 許可プロンプト制約を受けない）。

cd "$(dirname "$0")/.."

INPUT="$(cat)"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')"
TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""')"

STATE_DIR=".claude/.ai-check-suggest-state"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/${SESSION_ID}.hash"

# 7日より古い状態ファイルは掃除する（セッションごとに増え続けるのを防ぐ）
find "$STATE_DIR" -name '*.hash' -mtime +7 -delete 2>/dev/null || true

CHANGED_FILES="$( { git diff --name-only HEAD; git status --porcelain | awk '{print $2}'; } 2>/dev/null || true)"
CURRENT_HASH="$(printf '%s' "$CHANGED_FILES" | shasum -a 256 | awk '{print $1}')"

PREV_HASH=""
if [ -f "$STATE_FILE" ]; then
  PREV_HASH="$(cat "$STATE_FILE")"
fi

if [ "$CURRENT_HASH" = "$PREV_HASH" ]; then
  echo '{"systemMessage": ""}'
  exit 0
fi

# ソースコード変更（ドキュメント・設定のみの変更は対象外）がなければチェック不要
if ! printf '%s' "$CHANGED_FILES" | grep -qE '\.(ts|tsx|sql)$'; then
  echo '{"systemMessage": ""}'
  exit 0
fi

if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  echo '{"systemMessage": ""}'
  exit 0
fi

echo "$CURRENT_HASH" > "$STATE_FILE"

if grep -qE 'npm run (ai:check|typecheck|lint|test)\b' "$TRANSCRIPT" 2>/dev/null; then
  echo '{"systemMessage": ""}'
else
  MSG="ソースコード変更（.ts/.tsx/.sql）があるにもかかわらず、このセッションで npm run ai:check 相当のコマンド（typecheck/lint/test）が実行された痕跡が見当たりません。実行を検討してください。"
  jq -n --arg msg "$MSG" '{systemMessage: $msg}'
fi
