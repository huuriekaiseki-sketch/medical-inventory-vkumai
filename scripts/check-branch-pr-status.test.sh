#!/bin/bash
# WHY: scripts/check-branch-pr-status.sh(SessionStart hook)の回帰テスト。
# 実物のgit/ghに依存させず、テスト用のフェイクgit/ghスクリプトをPATHの先頭に注入して
# 決定的に検証する。
#
# 実行: bash scripts/check-branch-pr-status.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-branch-pr-status.sh"

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
trap 'rm -rf "$FAKE_BIN"' EXIT
BASH_BIN="$(command -v bash)"

setup_fakes() {
  local branch="$1" gh_output="$2" gh_available="${3:-1}"

  cat > "$FAKE_BIN/git" <<EOF
#!/bin/bash
if [ "\$1" = "branch" ] && [ "\$2" = "--show-current" ]; then
  echo "$branch"
  exit 0
fi
exit 0
EOF
  chmod +x "$FAKE_BIN/git"

  if [ "$gh_available" = "1" ]; then
    cat > "$FAKE_BIN/gh" <<EOF
#!/bin/bash
echo '$gh_output'
EOF
    chmod +x "$FAKE_BIN/gh"
  else
    rm -f "$FAKE_BIN/gh"
  fi
}

run_hook() {
  set +e
  OUT="$(PATH="$FAKE_BIN:$PATH" "$BASH_BIN" "$SCRIPT" < /dev/null)"
  EXIT_CODE=$?
  set -e
}

# gh不在ケース専用: 実PATH上のghディレクトリだけを取り除く
# (dirname/jq等の他coreutilsは実PATH由来のまま使わせる)
REAL_GH="$(command -v gh || true)"
GH_DIR="$(dirname "$REAL_GH" 2>/dev/null || true)"
PATH_WITHOUT_GH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -vF "$GH_DIR" | tr '\n' ':')"

run_hook_no_gh_on_path() {
  set +e
  OUT="$(PATH="$FAKE_BIN:$PATH_WITHOUT_GH" "$BASH_BIN" "$SCRIPT" < /dev/null)"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: mainブランチ → 何も出力しない ==="
setup_fakes "main" '[]'
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: featureブランチだがマージ済みPRなし → 何も出力しない ==="
setup_fakes "feature/foo" '[]'
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 3: featureブランチにマージ済みPRあり → 警告を出す ==="
setup_fakes "issue-20-orders-list-page" '[{"number":336,"title":"feat: 発注履歴ページ","url":"https://github.com/example/repo/pull/336"}]'
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "#336" "PR番号が含まれる"
assert_contains "$OUT" "additionalContext" "additionalContextフィールドがある"

echo "=== scenario 4: ghコマンドが無い環境 → 何も出力しない ==="
setup_fakes "feature/foo" '[]' "0"
run_hook_no_gh_on_path
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
