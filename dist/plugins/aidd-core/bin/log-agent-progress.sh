#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../scripts/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/agent-progress.jsonl"
AGENT=""
FEATURE=""
STATUS=""
NOTE=""

usage() {
  echo "Usage: $0 --agent NAME --feature NAME --status starting|running|waiting|done|failed --note TEXT [--log-file PATH]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) AGENT="$2"; shift 2 ;;
    --feature) FEATURE="$2"; shift 2 ;;
    --status) STATUS="$2"; shift 2 ;;
    --note) NOTE="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

for name in AGENT FEATURE STATUS NOTE; do
  if [[ -z "${!name}" ]]; then
    echo "Missing required argument: --$(echo "$name" | tr '[:upper:]' '[:lower:]')" >&2
    usage
  fi
done

case "$STATUS" in
  starting|running|waiting|done|failed) ;;
  *) echo "--status must be one of: starting|running|waiting|done|failed" >&2; exit 1 ;;
esac

mkdir -p "$(dirname "$LOG_FILE")"

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

jq -nc \
  --arg timestamp "$TIMESTAMP" \
  --arg agent "$AGENT" \
  --arg feature "$FEATURE" \
  --arg status "$STATUS" \
  --arg note "$NOTE" \
  '{timestamp: $timestamp, agent: $agent, feature: $feature, status: $status, note: $note}' \
  >> "$LOG_FILE"
