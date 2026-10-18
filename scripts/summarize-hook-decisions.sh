#!/usr/bin/env bash
set -euo pipefail

# 止める hook が deny / ask / warn を出した回の記録（hook-decisions.jsonl、lib/log-hook-decision.sh が書く）を
# 人が読める形にする（docs/specs/hook-decisions-summary.md）。集計の本体は lib/hook-decisions-summary.mjs。
#
# WHY: 記録（PR #896）ができても、読む出口が無ければ「hook が何を何回止めたか」は依然として誰も見ない。
#      月次サマリ（gate-effectiveness-monthly-check.sh）がこの出力を 1 段落として載せる。
#      記録が 0 件のときは「止めていない」と「記録が黙って飛んでいる」の両方の可能性を言う
#      （不在を合格と読まない。C-025）。
#
# 使い方: bash scripts/summarize-hook-decisions.sh [--log-file PATH] [--days N] [--json] [--no-heading] [--now ISO8601]
#   --days の既定は 30（月次サマリの期間に合わせる）。--now はテスト・再現用。
#   --no-heading は呼び出し側（月次サマリ）が見出しを持つとき（二重見出しを避ける）

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/hook-decisions.jsonl"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --days) ARGS+=(--days "$2"); shift 2 ;;
    --now) ARGS+=(--now "$2"); shift 2 ;;
    --json) ARGS+=(--json); shift ;;
    --no-heading) ARGS+=(--no-heading); shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "node が必要です" >&2; exit 1; }

exec node "$SCRIPT_DIR/lib/hook-decisions-summary.mjs" --log-file "$LOG_FILE" ${ARGS[@]+"${ARGS[@]}"}
