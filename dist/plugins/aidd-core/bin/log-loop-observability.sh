#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/loop-observability.jsonl"
LOOP="agentic"
AGENT=""
FEATURE=""
ATTEMPT=""
MODEL=""
INTENT=""
SCENARIO=""
RESULT=""
REASON=""

usage() {
  echo "Usage: $0 --agent NAME --feature NAME --attempt N --model NAME --intent TEXT --scenario TEXT --result pass|fail --reason TEXT [--loop agentic|developer|external] [--log-file PATH]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --loop) LOOP="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --feature) FEATURE="$2"; shift 2 ;;
    --attempt) ATTEMPT="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --intent) INTENT="$2"; shift 2 ;;
    --scenario) SCENARIO="$2"; shift 2 ;;
    --result) RESULT="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

for name in AGENT FEATURE ATTEMPT MODEL INTENT SCENARIO RESULT REASON; do
  if [[ -z "${!name}" ]]; then
    echo "Missing required argument: --$(echo "$name" | tr '[:upper:]' '[:lower:]')" >&2
    usage
  fi
done

if ! [[ "$ATTEMPT" =~ ^[0-9]+$ ]]; then
  echo "--attempt must be a non-negative integer" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

jq -nc \
  --arg timestamp "$TIMESTAMP" \
  --arg loop "$LOOP" \
  --arg agent "$AGENT" \
  --arg feature "$FEATURE" \
  --argjson attempt "$ATTEMPT" \
  --arg model "$MODEL" \
  --arg intent "$INTENT" \
  --arg scenario "$SCENARIO" \
  --arg result "$RESULT" \
  --arg reason "$REASON" \
  '{timestamp: $timestamp, loop: $loop, agent: $agent, feature: $feature, attempt: $attempt, model: $model, tokens: null, costUsd: null, intent: $intent, scenario: $scenario, result: $result, reason: $reason}' \
  >> "$LOG_FILE"
