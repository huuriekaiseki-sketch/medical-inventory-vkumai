#!/bin/bash
# WHY: scripts/check-local-main-freshness.sh(SessionStart hook、issue #499)の回帰テスト。
# 実物のgit/ネットワークに依存させず、フェイクgitスクリプトをPATHの先頭に注入して
# 決定的に検証する（check-branch-pr-status.test.shと同型）。
#
# 実行: bash scripts/check-local-main-freshness.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-local-main-freshness.sh"

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

WORKDIR="$(mktemp -d)"
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"
trap 'rm -rf "$WORKDIR"' EXIT
BASH_BIN="$(command -v bash)"

cat > "$FAKE_BIN/git" <<'EOF'
#!/bin/bash
if [ "$1" = "rev-parse" ] && [ "$2" = "--is-inside-work-tree" ]; then
  if [ "${FAKE_GIT_IS_REPO:-1}" = "0" ]; then
    exit 1
  fi
  echo "true"
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--git-path" ] && [ "$3" = "FETCH_HEAD" ]; then
  echo "${FAKE_FETCH_HEAD_PATH:-}"
  exit 0
fi
if [ "$1" = "rev-list" ] && [ "$2" = "--count" ]; then
  echo "${FAKE_BEHIND_COUNT:-0}"
  exit 0
fi
exit 0
EOF
chmod +x "$FAKE_BIN/git"

run_hook() {
  set +e
  OUT="$(PATH="$FAKE_BIN:$PATH" "$BASH_BIN" "$SCRIPT" < /dev/null)"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: fetch直近・behind=0 → 何も出力しない ==="
FRESH_FETCH_HEAD="$WORKDIR/fresh-fetch-head"
touch "$FRESH_FETCH_HEAD"
FAKE_FETCH_HEAD_PATH="$FRESH_FETCH_HEAD" FAKE_BEHIND_COUNT=0 run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: fetchが既定24時間より古い・behind=0 → 警告を出す ==="
STALE_FETCH_HEAD="$WORKDIR/stale-fetch-head"
touch "$STALE_FETCH_HEAD"
# 30時間前のmtimeにする(macOS/Linux両対応のためpython3で設定)
python3 -c "
import os, time
path = '$STALE_FETCH_HEAD'
old = time.time() - 30 * 3600
os.utime(path, (old, old))
"
FAKE_FETCH_HEAD_PATH="$STALE_FETCH_HEAD" FAKE_BEHIND_COUNT=0 run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "ローカルmainが古い可能性があります" "警告メッセージが含まれる"

echo "=== scenario 3: fetch直近・behind>0 → 警告を出す ==="
FAKE_FETCH_HEAD_PATH="$FRESH_FETCH_HEAD" FAKE_BEHIND_COUNT=5 run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "5コミット遅れています" "遅れコミット数が含まれる"

echo "=== scenario 4: FETCH_HEADファイルが存在しない(一度もfetchしていない) → 警告を出す ==="
FAKE_FETCH_HEAD_PATH="$WORKDIR/no-such-file" FAKE_BEHIND_COUNT=0 run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "fetch記録が見つかりません" "fetch未実施の旨が含まれる"

echo "=== scenario 5: gitリポジトリでない環境 → 何も出力しない ==="
FAKE_GIT_IS_REPO=0 FAKE_FETCH_HEAD_PATH="$STALE_FETCH_HEAD" FAKE_BEHIND_COUNT=5 run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 6: LOCAL_MAIN_STALE_HOURSで閾値を変更できる ==="
# 30時間前のfetchは既定(24時間)では古いが、閾値を48時間に上げれば古くない
python3 -c "
import os, time
path = '$STALE_FETCH_HEAD'
old = time.time() - 30 * 3600
os.utime(path, (old, old))
"
set +e
OUT="$(PATH="$FAKE_BIN:$PATH" FAKE_FETCH_HEAD_PATH="$STALE_FETCH_HEAD" FAKE_BEHIND_COUNT=0 LOCAL_MAIN_STALE_HOURS=48 "$BASH_BIN" "$SCRIPT" < /dev/null)"
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "閾値を緩めると警告が出ない"

echo "=== scenario 7: ネットワークアクセスを行わない(静的確認: git fetchをコマンドとして実行する行が無い) ==="
# メッセージ文中の案内(git fetch origin main してから...)は許容し、コマンドとしての
# 呼び出し(行頭または;/&&の後にgit fetchが来る形)が無いことだけを確認する。
FETCH_INVOCATIONS="$(grep -nE '(^|[;&|]) *git fetch' "$SCRIPT" || true)"
assert_empty "$FETCH_INVOCATIONS" "git fetchをコマンドとして呼び出す行が無い"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
