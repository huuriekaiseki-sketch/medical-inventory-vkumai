#!/usr/bin/env bash
# 複数のブランチを「この順で main へ入れたら衝突するか」を、作業ツリーを触らずに調べる。
# 詳しい WHY は scripts/lib/rehearse-merge.mjs の先頭。
#
# 使い方:
#   bash scripts/rehearse-merge.sh                                  # scripts/lib/merge-queue.json の順で
#   bash scripts/rehearse-merge.sh --branches feat/a,feat/b         # その場で順番を指定
#   bash scripts/rehearse-merge.sh --base origin/main --json        # 機械可読
#
#   bash scripts/rehearse-merge.sh --base main                      # 実際に積む先を指定
#   bash scripts/rehearse-merge.sh --base main --prune-merged       # 済みを順番ファイルから外す
#
# 終了コード: 0 = 衝突なし / 1 = 衝突あり / 2 = 使い方が違う /
#             3 = **起点が遅れていて判定できない**（既定の origin/main が凍っている等） /
#             4 = **対象なし**（順番が空、または全部が済みか無し。2026-09-11）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# 順番ファイルは導入先のリポジトリ側にある（プラグイン内のパスを既定にすると配布物側を見てしまう）
if [ -n "${MERGE_QUEUE:-}" ]; then
  QUEUE="$MERGE_QUEUE"
elif [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$CLAUDE_PROJECT_DIR/scripts/lib/merge-queue.json" ]; then
  QUEUE="$CLAUDE_PROJECT_DIR/scripts/lib/merge-queue.json"
else
  QUEUE="$SCRIPT_DIR/lib/merge-queue.json"
fi

has_branches=0
for a in "$@"; do
  if [ "$a" = "--branches" ] || [ "$a" = "--queue" ]; then has_branches=1; fi
done

# WHY(記録を残す、2026-09-10): ハーネスの地図で H-08（リリース）だけが実測の記録を持たず、
#      「入口をまだ作っていない」という**実態とずれた理由**が書かれていた。入口はここにある。
#      記録が無かっただけなので残す。**exec をやめて終了コードを受け取る**必要があるため、
#      実行して結果を見てから終わる形にする。
#      記録に失敗しても本題（予行の結果の表示）は止めない。
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

# WHY(終了コードは `||` で受ける、2026-09-11): 上の `set -e` の下で node を素のまま呼ぶと、
#      **合格以外（衝突 1・判定できない 3・対象なし 4）で、この場でスクリプトごと終わる**。
#      下の記録係まで届かず、**記録には合格しか残らなかった**（C-044。実際に記録は pass だけだった）。
#      ハーネスの証拠の欄は「最後の合格」を出し続ける——**衝突が出ても赤にならない**（E-084）。
REHEARSE_EXIT=0
if [ "$has_branches" -eq 1 ]; then
  set -- --repo "$REPO_ROOT" "$@"
else
  set -- --repo "$REPO_ROOT" --queue "$QUEUE" "$@"
fi
node "$SCRIPT_DIR/lib/rehearse-merge.mjs" "$@" || REHEARSE_EXIT=$?

record_rehearsal() {
  local log_dir
  log_dir="$(resolve_log_dir)" || return 0
  mkdir -p "$log_dir" 2>/dev/null || return 0
  local log_file="$log_dir/release-rehearsal-runs.jsonl"

  # 4 値。衝突なし / 衝突あり / 対象なし / 判定できない を 1 つに潰さない（C-025）
  local result
  case "$REHEARSE_EXIT" in
    0) result="pass" ;;
    1) result="fail" ;;
    4) result="empty" ;;
    *) result="unmeasured" ;;
  esac

  local commit branch base
  commit="$(git -C "$REPO_ROOT" rev-parse --short --verify --quiet HEAD 2>/dev/null || echo unknown)"
  branch="$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null || echo unknown)"
  [ -n "$branch" ] || branch=unknown
  # 起点。--base を明示していればそれ、無ければ既定
  base="origin/main"
  local prev=""
  for a in "$@"; do
    if [ "$prev" = "--base" ]; then base="$a"; fi
    prev="$a"
  done

  python3 - "$log_file" "$result" "$REHEARSE_EXIT" "$commit" "$branch" "$base" <<'PY' || return 0
import json, sys
from datetime import datetime, timezone

log_file, result, exit_code, commit, branch, base = sys.argv[1:7]
row = {
    "at": datetime.now(timezone.utc).isoformat(),
    # pass=衝突なし / fail=衝突あり / empty=対象なし（順番が空・全部が済みか無し） / unmeasured=判定できない（起点が遅れている等）
    "result": result,
    "exitCode": int(exit_code),
    # 鮮度は**コミット**で見る。マージ予行の結果は「いま main に何が入っているか」に依存し、
    # どれか 1 つのディレクトリの木では表せない
    "commit": commit,
    "branch": branch,
    "base": base,
}
with open(log_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
print(f"[rehearse-merge] {result} を記録しました: {log_file}", file=sys.stderr)
PY
  return 0
}

record_rehearsal "$@"
exit "$REHEARSE_EXIT"
