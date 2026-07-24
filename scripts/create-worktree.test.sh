#!/bin/bash
# WHY: create-worktree.shの回帰テスト。git worktree自体の実動作を検証したいため、
# 他の*.test.shのようなフェイクgit注入ではなく、一時ディレクトリに実物のgitリポジトリ
# (bare origin + working copy)を作って統合的に検証する。
#
# 実行: bash scripts/create-worktree.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/create-worktree.sh"

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  OK: $label"
  else
    echo "  NG: $label"
    echo "      expected to find: $needle"
    echo "      actual: $haystack"
    fail=1
  fi
}
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}
assert_file_exists() {
  local path="$1" label="$2"
  if [ -f "$path" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (not found: $path)"
    fail=1
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ORIGIN="$TMP/origin.git"
WORK="$TMP/work"

git init --bare -q "$ORIGIN"

git init -q "$WORK"
git -C "$WORK" config user.email "test@example.com"
git -C "$WORK" config user.name "Test"
git -C "$WORK" checkout -q -b main
echo "readme" > "$WORK/README.md"
git -C "$WORK" add README.md
git -C "$WORK" commit -q -m "init"
git -C "$WORK" remote add origin "$ORIGIN"
git -C "$WORK" push -q -u origin main

# git管理外ファイル(.env.local相当)。worktree作成後にコピーされることを検証する対象
echo "NEXT_PUBLIC_SUPABASE_URL=dummy" > "$WORK/.env.local"
echo "NEXT_PUBLIC_SUPABASE_URL=dummy-test" > "$WORK/.env.test"

run_script() {
  set +e
  OUT="$(cd "$WORK" && "$SCRIPT" "$@" 2>&1)"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: 新規ブランチ作成 + .env.local/.env.testが自動コピーされる ==="
run_script "feature/new-thing"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "Worktree ready" "完了メッセージが出る"
assert_file_exists "$WORK/.claude/worktrees/new-thing/.env.local" ".env.localがworktreeにコピーされている"
assert_file_exists "$WORK/.claude/worktrees/new-thing/.env.test" ".env.testがworktreeにコピーされている"
assert_eq "$(git -C "$WORK" branch --list "feature/new-thing" | tr -d ' *+')" "feature/new-thing" "新規ブランチが作成されている"

echo "=== scenario 2: 既存ローカルブランチを指定 → 新規作成せずそのまま使う ==="
git -C "$WORK" branch existing-branch main
run_script "existing-branch"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "既存ローカルブランチ" "既存ブランチ使用メッセージが出る"
assert_file_exists "$WORK/.claude/worktrees/existing-branch/.env.local" ".env.localがコピーされている"

echo "=== scenario 3: 既に同名worktreeディレクトリがある → エラーで停止 ==="
run_script "feature/new-thing"
assert_eq "$EXIT_CODE" "1" "exit 1"
assert_contains "$OUT" "既に存在します" "重複エラーメッセージが出る"

echo "=== scenario 4: .env.local/.env.testが無い環境 → 警告のみでworktree作成自体は成功 ==="
rm "$WORK/.env.local" "$WORK/.env.test"
run_script "feature/no-env"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "見つからないためコピーをスキップ" "警告メッセージが出る"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
