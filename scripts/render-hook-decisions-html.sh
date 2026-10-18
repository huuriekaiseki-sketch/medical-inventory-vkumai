#!/usr/bin/env bash
set -euo pipefail

# 止めた回の記録・ハーネスの成績・hook 一覧を静的 HTML 1 枚にする（docs/specs/hook-decisions-summary.md）。
# 本体は lib/render-hook-decisions-html.mjs。Next.js は使わず src/ にも触れない。
#
# WHY: 棚卸しのたびに「止めた回数」「成績」「どの hook に .test.sh があり、いつ実走したか」を
#      3 か所開いて突き合わせていた。1 枚に並べる。見た目より中身の正確さを優先し、記録が
#      0〜数件のときは表でなく文・行で出す（集計スクリプトと同じ関数・同じ規則）。
#
# 使い方: bash scripts/render-hook-decisions-html.sh [--days N] [--out PATH] [--log-file PATH] [--root DIR]
#                                                   [--now ISO8601] [--score-cmd CMD] [--drill PATH]
#   既定の出力先は <共有 logs>/hook-decisions.html（resolve_log_dir。git 管理外）。
#   --now / --score-cmd / --drill はテスト・再現用

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
LOG_FILE="$(resolve_log_dir)/hook-decisions.jsonl"
OUT="$(resolve_log_dir)/hook-decisions.html"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --days) ARGS+=(--days "$2"); shift 2 ;;
    --now) ARGS+=(--now "$2"); shift 2 ;;
    --score-cmd) ARGS+=(--score-cmd "$2"); shift 2 ;;
    --drill) ARGS+=(--drill "$2"); shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "node が必要です" >&2; exit 1; }

exec node "$SCRIPT_DIR/lib/render-hook-decisions-html.mjs" --root "$ROOT" --log-file "$LOG_FILE" --out "$OUT" ${ARGS[@]+"${ARGS[@]}"}
