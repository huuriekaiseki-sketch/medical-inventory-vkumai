#!/usr/bin/env bash
# 複数のブランチを「この順で main へ入れたら衝突するか」を、作業ツリーを触らずに調べる。
# 詳しい WHY は scripts/lib/rehearse-merge.mjs の先頭。
#
# 使い方:
#   bash scripts/rehearse-merge.sh                                  # scripts/lib/merge-queue.json の順で
#   bash scripts/rehearse-merge.sh --branches feat/a,feat/b         # その場で順番を指定
#   bash scripts/rehearse-merge.sh --base origin/main --json        # 機械可読
#
# 終了コード: 衝突が 1 件でもあれば 1
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

if [ "$has_branches" -eq 1 ]; then
  exec node "$SCRIPT_DIR/lib/rehearse-merge.mjs" --repo "$REPO_ROOT" "$@"
fi
exec node "$SCRIPT_DIR/lib/rehearse-merge.mjs" --repo "$REPO_ROOT" --queue "$QUEUE" "$@"
