#!/bin/bash
# WHY: scripts/lib/resolve-log-dir.sh（logs/集約、issue #546）の回帰テスト。
# 実物のgit worktree構成を一時ディレクトリに作って決定的に検証する。
#
# 実行: bash scripts/lib/resolve-log-dir.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/resolve-log-dir.sh"

fail=0
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

echo "=== scenario 1: AIDD_LOG_DIR環境変数が最優先される ==="
OUT="$(cd "$SANDBOX" && AIDD_LOG_DIR="/tmp/explicit-override" bash -c "source '$LIB'; resolve_log_dir")"
assert_eq "$OUT" "/tmp/explicit-override" "環境変数の値をそのまま返す"

echo "=== scenario 2: gitリポジトリでない場合は相対'logs'にフォールバックする ==="
NON_GIT_DIR="$SANDBOX/plain"
mkdir -p "$NON_GIT_DIR"
OUT="$(cd "$NON_GIT_DIR" && bash -c "source '$LIB'; resolve_log_dir")"
assert_eq "$OUT" "logs" "gitでない環境では従来どおり相対'logs'を返す"

echo "=== scenario 3: メインworktreeとlinked worktreeが同じlogsディレクトリに解決される ==="
REPO="$SANDBOX/main-repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email "test@example.com"
git -C "$REPO" config user.name "test"
echo "placeholder" > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -q -m "init"

WORKTREE="$SANDBOX/linked-worktree"
git -C "$REPO" worktree add -q -b feature-branch "$WORKTREE" >/dev/null 2>&1

FROM_MAIN="$(cd "$REPO" && bash -c "source '$LIB'; resolve_log_dir")"
FROM_WORKTREE="$(cd "$WORKTREE" && bash -c "source '$LIB'; resolve_log_dir")"
REPO_PHYSICAL="$(cd "$REPO" && pwd -P)"
assert_eq "$FROM_MAIN" "$REPO_PHYSICAL/logs" "メインworktreeではリポジトリ直下のlogsに解決される"
assert_eq "$FROM_WORKTREE" "$FROM_MAIN" "linked worktreeもメインworktreeと同じlogsディレクトリに解決される"

echo "=== scenario 4: linked worktreeのサブディレクトリからでも同じ結果になる ==="
mkdir -p "$WORKTREE/scripts/nested"
FROM_NESTED="$(cd "$WORKTREE/scripts/nested" && bash -c "source '$LIB'; resolve_log_dir")"
assert_eq "$FROM_NESTED" "$FROM_MAIN" "サブディレクトリからでもメインworktree基準のlogsに解決される"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
