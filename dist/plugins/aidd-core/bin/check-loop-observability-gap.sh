#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../scripts/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/loop-observability.jsonl"
BEFORE_COUNT=""
EXPECTED_COUNT=""

usage() {
  echo "Usage: $0 --before N --expected M [--log-file PATH]" >&2
  echo "  --before N    フロー実行前に計測した logs/loop-observability.jsonl の行数" >&2
  echo "  --expected M  ワークフローの戻り値 expectedLoopObservabilityRecords" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --before) BEFORE_COUNT="$2"; shift 2 ;;
    --expected) EXPECTED_COUNT="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

if [[ -z "$BEFORE_COUNT" || -z "$EXPECTED_COUNT" ]]; then
  usage
fi

if [[ ! -f "$LOG_FILE" ]]; then
  AFTER_COUNT=0
else
  AFTER_COUNT="$(wc -l < "$LOG_FILE" | tr -d ' ')"
fi

ACTUAL_COUNT=$(( AFTER_COUNT - BEFORE_COUNT ))

# WHY: npx tsx はレジストリ依存で遅い日に数分かかる（harvest-journal-events.sh のコメント参照）。
#      実体は .js（ESM）なので node で直接実行する
node --experimental-detect-module --no-warnings "$SCRIPT_DIR/../scripts/workflow-lib/loop-observability-gap.js" --actual "$ACTUAL_COUNT" --expected "$EXPECTED_COUNT"
