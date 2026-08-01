#!/usr/bin/env bash
set -euo pipefail

# WHY: issue #569残タスク・issue #578/#579レビューを踏まえた対応。
# summarize-loop-observability.sh（logs/loop-observability.jsonlのみ参照）は自己申告の
# pass/failしか集計できず、`blocked`状態（Spec Check/Manifest Check等）は集計に一切現れない
# 既知の欠落があった（gate-effectiveness-monthly-check.shはアラート設計そのものであり、
# この欠落は「集計の見た目の問題」ではなく監視精度の問題）。
# journalAdapter（scripts/lib/canonical-event.ts）はWorkflow journal.jsonlのstatus
# （pass/fail/blocked）を既に正規化しているため、それをそのまま再利用してblocked件数を
# agentType別に集計する。詳細は scripts/lib/gate-effectiveness-summary.ts 参照。
#
# 使い方: scripts/summarize-gate-blocked.sh [--project-dir PATH] [--json]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir) ARGS+=(--project-dir "$2"); shift 2 ;;
    --json) ARGS+=(--json); shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

npx -y tsx "$SCRIPT_DIR/lib/gate-effectiveness-summary.ts" ${ARGS[@]+"${ARGS[@]}"}
