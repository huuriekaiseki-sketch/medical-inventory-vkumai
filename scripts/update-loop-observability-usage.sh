#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="${1:-$(resolve_log_dir)/loop-observability.jsonl}"
PROJECTS_ROOT="${2:-$HOME/.claude/projects}"

npx -y tsx "$SCRIPT_DIR/lib/aggregate-loop-observability-usage.ts" "$LOG_FILE" "$PROJECTS_ROOT"
