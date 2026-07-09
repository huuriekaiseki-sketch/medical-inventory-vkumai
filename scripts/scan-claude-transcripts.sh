#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 --filter-file PATH [--scope subagents|main|all] [--project-dir PATH] [--raw]" >&2
  echo "  Applies a jq filter to every matching Claude Code transcript (.jsonl)." >&2
  echo "  Read-only: only prints to stdout, never writes to the transcript files." >&2
  exit 1
}

SCOPE="all"
FILTER_FILE=""
PROJECT_DIR="$HOME/.claude/projects/-Users-masanori-medical-inventory-vkumai"
JQ_MODE="-c"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --filter-file) FILTER_FILE="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --raw) JQ_MODE="-r"; shift ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

[[ -n "$FILTER_FILE" ]] || usage
[[ -f "$FILTER_FILE" ]] || { echo "filter file not found: $FILTER_FILE" >&2; exit 1; }
[[ -d "$PROJECT_DIR" ]] || { echo "project dir not found: $PROJECT_DIR" >&2; exit 1; }

case "$SCOPE" in
  subagents) FIND_ARGS=("$PROJECT_DIR" -path "*/subagents/*.jsonl") ;;
  main) FIND_ARGS=("$PROJECT_DIR" -maxdepth 2 -name "*.jsonl" -not -path "*/subagents/*") ;;
  all) FIND_ARGS=("$PROJECT_DIR" -name "*.jsonl") ;;
  *) echo "Unknown scope: $SCOPE (expected subagents|main|all)" >&2; usage ;;
esac

while IFS= read -r -d '' file; do
  jq "$JQ_MODE" -f "$FILTER_FILE" "$file"
done < <(find "${FIND_ARGS[@]}" -print0)
