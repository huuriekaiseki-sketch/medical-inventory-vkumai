#!/usr/bin/env bash
set -euo pipefail

# WHY: issue #642。月次品質ゲートサマリのagent別pass/fail/blocked集計を、自己申告の
# loop-observability.jsonlではなく機械記録のjournal(収穫済みlogs/journal-harvest.jsonl)
# ベースで出す。旧scripts/summarize-gate-blocked.sh(blockedのみ集計、issue #569)は
# 本スクリプトに統合して廃止した(pass/fail/blockedを同じ集計で一度に出すため)。
# 詳細は scripts/lib/gate-effectiveness-summary.ts 参照。
#
# 使い方: scripts/summarize-gate-passfail.sh [--harvest-file PATH] [--json]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

HARVEST_FILE="$(resolve_log_dir)/journal-harvest.jsonl"

ARGS=()
JSON_FLAG=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --harvest-file) HARVEST_FILE="$2"; shift 2 ;;
    --json) JSON_FLAG=(--json); shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# WHY: npx tsx はレジストリ依存で CI が遅い日に数分かかる（harvest-journal-events.sh のコメント参照）。
#      Node 標準の型除去で直接実行する
node --experimental-strip-types --no-warnings "$SCRIPT_DIR/lib/gate-effectiveness-summary.ts" --harvest-file "$HARVEST_FILE" ${JSON_FLAG[@]+"${JSON_FLAG[@]}"}
