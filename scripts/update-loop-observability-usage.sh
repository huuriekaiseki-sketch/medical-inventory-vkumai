#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="${1:-$(resolve_log_dir)/loop-observability.jsonl}"
PROJECTS_ROOT="${2:-$HOME/.claude/projects}"

# WHY: npx tsx はレジストリ依存で遅い日に数分かかる（harvest-journal-events.sh のコメント参照）。
#      Node 標準の型除去で直接実行する
node --experimental-strip-types --no-warnings "$SCRIPT_DIR/lib/aggregate-loop-observability-usage.ts" "$LOG_FILE" "$PROJECTS_ROOT"
