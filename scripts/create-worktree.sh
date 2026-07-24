#!/bin/bash
# WHY: git worktreeはgit管理外ファイル（.env.local等）を新規worktreeへ引き継がないため、
# 新しいworktreeを作るたびにSupabase接続情報が欠落しRuntime Errorになっていた(issue発生源:
# supabase-env-config-325893セッション)。worktree作成をこのスクリプト経由に一本化し、
# .env.local/.env.testの手動コピー漏れを構造的に防ぐ。
# あわせてdocs/agents/common.md「ブランチ運用ルール」(origin/main起点でのbranch作成)も
# 機械的に強制する。
#
# Usage: scripts/create-worktree.sh <branch-name> [base-branch]
#   branch-name: 例 claude/my-feature。既存ローカルブランチがあればそれを使う、無ければ
#                base-branchから新規作成する
#   base-branch: 省略時 origin/main
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <branch-name> [base-branch]" >&2
  exit 1
fi

BRANCH_NAME="$1"
BASE_BRANCH="${2:-origin/main}"
WORKTREE_BASENAME="${BRANCH_NAME##*/}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="$REPO_ROOT/.claude/worktrees/$WORKTREE_BASENAME"

if [ -e "$WORKTREE_DIR" ]; then
  echo "Error: $WORKTREE_DIR は既に存在します" >&2
  exit 1
fi

echo "Fetching origin/main..."
git fetch origin main

if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  echo "既存ローカルブランチ $BRANCH_NAME を使用します"
  git worktree add "$WORKTREE_DIR" "$BRANCH_NAME"
else
  echo "$BASE_BRANCH から新規ブランチ $BRANCH_NAME を作成します"
  git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME" "$BASE_BRANCH"
fi

for f in .env.local .env.test; do
  if [ -f "$REPO_ROOT/$f" ]; then
    cp "$REPO_ROOT/$f" "$WORKTREE_DIR/$f"
    echo "Copied $f -> $WORKTREE_DIR/$f"
  else
    echo "Warning: $REPO_ROOT/$f が見つからないためコピーをスキップしました" >&2
  fi
done

echo "Worktree ready: $WORKTREE_DIR (branch: $BRANCH_NAME)"
