#!/bin/bash
# WHY: scripts/check-stale-worktrees.sh(SessionStart hook)の回帰テスト。
# 実物のgit/gh/マーカーファイルに依存させず、テスト用のフェイクgit/ghをPATHの先頭に注入し、
# マーカーファイルもテンポラリディレクトリへ切り替えて決定的に検証する。
#
# 実行: bash scripts/check-stale-worktrees.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-stale-worktrees.sh"

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
assert_empty() {
  local actual="$1" label="$2"
  if [ -z "$actual" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (actual=$actual)"
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

FAKE_BIN="$(mktemp -d)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN" "$WORK_DIR"' EXIT
BASH_BIN="$(command -v bash)"

# git worktree list --porcelain / git branch -vv の両方をフェイクgitで切り替える。
# gh pr list --state all --json state --limit 5 の応答は $1 の内容次第で固定JSONを返す。
setup_fakes() {
  local worktree_porcelain="$1" branch_vv="$2" gh_json="$3"

  cat > "$FAKE_BIN/git" <<EOF
#!/bin/bash
if [ "\$1" = "worktree" ] && [ "\$2" = "list" ]; then
  cat <<'WT_EOF'
$worktree_porcelain
WT_EOF
  exit 0
fi
if [ "\$1" = "branch" ] && [ "\$2" = "-vv" ]; then
  cat <<'BR_EOF'
$branch_vv
BR_EOF
  exit 0
fi
exit 0
EOF
  chmod +x "$FAKE_BIN/git"

  cat > "$FAKE_BIN/gh" <<EOF
#!/bin/bash
echo '$gh_json'
EOF
  chmod +x "$FAKE_BIN/gh"
}

run_hook() {
  local session_id="$1"
  set +e
  OUT="$(cd "$WORK_DIR" && STALE_WORKTREES_SESSION_ID="$session_id" \
    STALE_WORKTREES_MARKER_FILE="$WORK_DIR/.aidd/marker.json" \
    STALE_WORKTREES_MAX_CHECK=10 STALE_WORKTREES_GONE_THRESHOLD=10 \
    PATH="$FAKE_BIN:$PATH" "$BASH_BIN" "$SCRIPT" < /dev/null)"
  EXIT_CODE=$?
  set -e
}

WT_NONE="worktree /repo
HEAD abc123
branch refs/heads/main"

WT_STALE="worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo/.claude/worktrees/foo
HEAD def456
branch refs/heads/issue-1-foo"

WT_STALE_WITH_DETACHED="worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo/.codex/worktrees/1/foo
HEAD 999def
detached

worktree /repo/.claude/worktrees/foo
HEAD def456
branch refs/heads/issue-1-foo"

BR_NONE="* main abc123 commit"
BR_GONE_MANY="  b1 aaa [origin/b1: gone] c
  b2 aaa [origin/b2: gone] c
  b3 aaa [origin/b3: gone] c
  b4 aaa [origin/b4: gone] c
  b5 aaa [origin/b5: gone] c
  b6 aaa [origin/b6: gone] c
  b7 aaa [origin/b7: gone] c
  b8 aaa [origin/b8: gone] c
  b9 aaa [origin/b9: gone] c
  b10 aaa [origin/b10: gone] c
* main aaa commit"

echo "=== scenario 1: 残骸なし → 何も出力しない ==="
setup_fakes "$WT_NONE" "$BR_NONE" '[]'
run_hook "session-1"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: マージ済みPRを持つworktreeあり → 警告を出す ==="
setup_fakes "$WT_STALE" "$BR_NONE" '[{"state":"MERGED"}]'
run_hook "session-2"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "issue #674" "issue番号が含まれる"

echo "=== scenario 3: goneブランチが閾値以上 → 警告を出す ==="
setup_fakes "$WT_NONE" "$BR_GONE_MANY" '[]'
run_hook "session-3"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "10件" "gone件数が含まれる"

echo "=== scenario 3b: detached worktreeが混在していてもクラッシュせず処理される ==="
setup_fakes "$WT_STALE_WITH_DETACHED" "$BR_NONE" '[{"state":"MERGED"}]'
run_hook "session-3b"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "detached混在でもbranch持ちworktreeは検知される"

echo "=== scenario 4: 同一セッションで2回目 → 沈黙する ==="
setup_fakes "$WT_STALE" "$BR_NONE" '[{"state":"MERGED"}]'
run_hook "session-4"
assert_contains "$OUT" "systemMessage" "1回目は警告を出す"
run_hook "session-4"
assert_empty "$OUT" "2回目は沈黙する"

echo "=== scenario 5: 別セッションIDなら再度警告する ==="
setup_fakes "$WT_STALE" "$BR_NONE" '[{"state":"MERGED"}]'
run_hook "session-5"
assert_contains "$OUT" "systemMessage" "session-5は警告を出す"
run_hook "session-6"
assert_contains "$OUT" "systemMessage" "別セッションsession-6も警告を出す"

echo "=== scenario 6: ghコマンドが無い環境 → 何も出力しない(fail-open) ==="
setup_fakes "$WT_STALE" "$BR_NONE" '[{"state":"MERGED"}]'
rm -f "$FAKE_BIN/gh"
# 実PATH上のghディレクトリだけを取り除く(dirname/jq等の他coreutilsは実PATH由来のまま使わせる)
REAL_GH="$(command -v gh || true)"
GH_DIR="$(dirname "$REAL_GH" 2>/dev/null || true)"
PATH_WITHOUT_GH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -vF "$GH_DIR" | tr '\n' ':')"
set +e
OUT="$(cd "$WORK_DIR" && STALE_WORKTREES_SESSION_ID="session-7" \
  STALE_WORKTREES_MARKER_FILE="$WORK_DIR/.aidd/marker-no-gh.json" \
  PATH="$FAKE_BIN:$PATH_WITHOUT_GH" "$BASH_BIN" "$SCRIPT" < /dev/null)"
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
