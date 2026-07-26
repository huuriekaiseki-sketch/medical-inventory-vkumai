#!/usr/bin/env bash
set -euo pipefail

# issue #432: aidd-1-1-deep-task.jsの戻り値.findAvPrecision（Find指摘のAdversarial Verify
# 生存率。Sweep指摘のprecisionではない。理由は.claude/workflows/lib/find-av-precision.jsの
# コメント参照）を永続化する。
#
# Workflow DSL自体はfilesystem API不可のため、フローの戻り値をこのスクリプトへ渡すのは
# 呼び出し元（Claude Code）の責務。ai_check_suggest.sh等と同じ「機械強制ではなく人/エージェント
# 起動の第3層ルール」である点に注意（common.md「検知手段のないルールの棚卸し」参照）。
#
# 使い方（fourth-argument経由でJSONを渡す。パイプ・stdinは使わない）:
#   scripts/log-find-av-precision.sh --feature "<feature名>" '<findAvPrecisionのJSON>'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/find-av-precision.jsonl"
FEATURE=""

usage() {
  echo "Usage: $0 --feature NAME '<findAvPrecision JSON>' [--log-file PATH]" >&2
  exit 1
}

STATS_JSON=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --feature) FEATURE="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    *) STATS_JSON="$1"; shift ;;
  esac
done

if [[ -z "$FEATURE" || -z "$STATS_JSON" ]]; then
  usage
fi

if ! printf '%s' "$STATS_JSON" | jq empty 2>/dev/null; then
  echo "Invalid JSON: $STATS_JSON" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

jq -nc \
  --arg timestamp "$TIMESTAMP" \
  --arg feature "$FEATURE" \
  --argjson stats "$STATS_JSON" \
  '{timestamp: $timestamp, feature: $feature} + $stats' \
  >> "$LOG_FILE"
