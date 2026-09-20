#!/bin/bash
# issue #446フォローアップ: subagentStatusLineのtasks配列（id/name/type/status/description/
# label/startTime/model/contextWindowSize/tokenCount/tokenSamples/cwd）は公式ドキュメントに
# フィールド名の記載はあるが完全なJSONサンプルが無く、特にstartTimeの型・フォーマットが未確認。
# このスクリプトは実装のための一時的な実測専用ツールで、subagentStatusLineとして設定し、
# 受け取った生JSONをそのままlogs/subagent-statusline-debug.jsonlに追記する。
# 行のoverrideは一切出力しない（=デフォルト表示のまま）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY(issue #805): 他の記録と同じく全 worktree 共有の logs/ へ書く。スクリプト位置からの相対だと、
# git worktree から設定したときに worktree 直下へ書かれ、worktree を消すと実測結果ごと消える
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"
LOG_DIR="$(cd "$SCRIPT_DIR/.." && resolve_log_dir)"
LOG_FILE="$LOG_DIR/subagent-statusline-debug.jsonl"

mkdir -p "$LOG_DIR"

input=$(cat)
ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "$input" | jq -c --arg capturedAt "$ts" '. + {_capturedAt: $capturedAt}' >> "$LOG_FILE" 2>/dev/null || true

exit 0
