#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${1:-logs/loop-observability.jsonl}"
PROJECTS_ROOT="${2:-$HOME/.claude/projects}"

npx -y tsx scripts/lib/aggregate-loop-observability-usage.ts "$LOG_FILE" "$PROJECTS_ROOT"
