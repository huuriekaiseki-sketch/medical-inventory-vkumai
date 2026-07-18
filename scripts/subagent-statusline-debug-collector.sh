#!/bin/bash
# issue #446フォローアップ: subagentStatusLineのtasks配列（id/name/type/status/description/
# label/startTime/model/contextWindowSize/tokenCount/tokenSamples/cwd）は公式ドキュメントに
# フィールド名の記載はあるが完全なJSONサンプルが無く、特にstartTimeの型・フォーマットが未確認。
# このスクリプトは実装のための一時的な実測専用ツールで、subagentStatusLineとして設定し、
# 受け取った生JSONをそのままlogs/subagent-statusline-debug.jsonlに追記する。
# 行のoverrideは一切出力しない（=デフォルト表示のまま）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$REPO_ROOT/logs/subagent-statusline-debug.jsonl"

mkdir -p "$REPO_ROOT/logs"

input=$(cat)
ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "$input" | jq -c --arg capturedAt "$ts" '. + {_capturedAt: $capturedAt}' >> "$LOG_FILE" 2>/dev/null || true

exit 0
