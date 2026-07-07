#!/usr/bin/env bash
set -euo pipefail

# Stop hookから呼ばれる。domain.md/decisions.mdの更新候補があるかを機械的にチェックし、
# systemMessageをJSONで出力する（Claude本体のBashツールを経由しないため、非対話環境の
# 許可プロンプト制約を受けない）。

cd "$(dirname "$0")/.."

INPUT="$(cat)"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')"

STATE_DIR=".claude/.doc-suggest-state"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/${SESSION_ID}.hash"

# 7日より古い状態ファイルは掃除する（セッションごとに増え続けるのを防ぐ）
find "$STATE_DIR" -name '*.hash' -mtime +7 -delete 2>/dev/null || true

DIFF_CONTENT="$( { git diff HEAD; git status --porcelain; } 2>/dev/null || true)"
CURRENT_HASH="$(printf '%s' "$DIFF_CONTENT" | shasum -a 256 | awk '{print $1}')"

PREV_HASH=""
if [ -f "$STATE_FILE" ]; then
  PREV_HASH="$(cat "$STATE_FILE")"
fi

if [ "$CURRENT_HASH" = "$PREV_HASH" ]; then
  echo '{"systemMessage": ""}'
  exit 0
fi

echo "$CURRENT_HASH" > "$STATE_FILE"

if printf '%s' "$DIFF_CONTENT" | grep -qE 'supabase/migrations|src/lib/supabase|middleware\.ts|facility|tenant|organization|inventory|RLS|policy|\bauth\b'; then
  MSG="このセッションはfacility/tenant/RLS等のドメインに触れています。docs/agents/domain.md（新しいドメイン用語）とdocs/agents/decisions.md（後戻りしづらい・トレードオフのある設計判断）に追記すべき内容がないか確認してください。"
  jq -n --arg msg "$MSG" '{systemMessage: $msg}'
else
  echo '{"systemMessage": ""}'
fi
