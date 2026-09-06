#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../scripts/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/agent-progress.jsonl"
BEFORE_COUNT=""
EXPECTED_COUNT=""

usage() {
  echo "Usage: $0 --before N --expected M [--log-file PATH]" >&2
  echo "  --before N    フロー実行前に計測した logs/agent-progress.jsonl のstatus=done|failed行数" >&2
  echo "  --expected M  ワークフローの戻り値 stats.expectedAgentProgressRecords" >&2
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
  AFTER_COUNT="$(jq -s '[.[] | select(.status == "done" or .status == "failed")] | length' "$LOG_FILE")"
fi

ACTUAL_COUNT=$(( AFTER_COUNT - BEFORE_COUNT ))

# WHY: npx tsx はレジストリ依存で遅い日に数分かかる（harvest-journal-events.sh のコメント参照）。
#      実体は .js（ESM）なので node で直接実行する（"type":"module" 無しの .js のため構文検出フラグを付ける）
node --experimental-detect-module --no-warnings "$SCRIPT_DIR/../scripts/workflow-lib/agent-progress-gap.js" --actual "$ACTUAL_COUNT" --expected "$EXPECTED_COUNT"
