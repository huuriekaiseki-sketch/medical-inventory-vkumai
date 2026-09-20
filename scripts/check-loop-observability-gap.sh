#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

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

# WHY(issue #812): 総行数ではなく「フローの記録」だけを数える（E2E の reporter も同じログに書く）。
# before 側（record-gap-check-state.sh）と同じ関数を使う。別々に数えると差が合わない
source "$SCRIPT_DIR/lib/count-flow-loop-records.sh"
AFTER_COUNT="$(count_flow_loop_records "$LOG_FILE")"

ACTUAL_COUNT=$(( AFTER_COUNT - BEFORE_COUNT ))

# WHY: npx tsx はレジストリ依存で遅い日に数分かかる（harvest-journal-events.sh のコメント参照）。
#      実体は .js（ESM）なので node で直接実行する
node --experimental-detect-module --no-warnings "$SCRIPT_DIR/../.claude/workflows/lib/loop-observability-gap.js" --actual "$ACTUAL_COUNT" --expected "$EXPECTED_COUNT"
