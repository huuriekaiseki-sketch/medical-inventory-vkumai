#!/bin/bash
# WHY: scripts/check-blocked-issues-staleness.sh(SessionStart hook)の回帰テスト。
# 実物のghに依存させず、テスト用のフェイクghスクリプトをPATHの先頭に注入して決定的に検証する
# （scripts/check-branch-pr-status.test.shと同じパターン）。
#
# 実行: bash scripts/check-blocked-issues-staleness.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-blocked-issues-staleness.sh"

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

# 現在時刻基準の相対日時をISO8601で生成する（テスト実行時刻に依存せず決定的にするため）
days_ago_iso() {
  python3 -c "
from datetime import datetime, timezone, timedelta
print((datetime.now(timezone.utc) - timedelta(days=$1)).strftime('%Y-%m-%dT%H:%M:%SZ'))
"
}

setup_fake_gh() {
  local gh_output="$1" gh_available="${2:-1}"

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
  OUT="$(PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" < /dev/null)"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: blocked issueが無い → 何も出力しない ==="
setup_fake_gh '[]'
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: blocked issueはあるが90日以内に更新済み → 何も出力しない ==="
RECENT="$(days_ago_iso 10)"
setup_fake_gh "[{\"number\":438,\"title\":\"Bashサンドボックス\",\"updatedAt\":\"$RECENT\",\"url\":\"https://example.com/438\"}]"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 3: blocked issueが90日以上未更新 → 警告する ==="
STALE="$(days_ago_iso 100)"
setup_fake_gh "[{\"number\":438,\"title\":\"Bashサンドボックス\",\"updatedAt\":\"$STALE\",\"url\":\"https://example.com/438\"}]"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "#438" "issue番号が含まれる"
assert_contains "$OUT" "additionalContext" "additionalContextフィールドがある"

echo "=== scenario 4: 複数issue、一部だけstale → staleな分だけ列挙される ==="
FRESH="$(days_ago_iso 5)"
STALE2="$(days_ago_iso 200)"
setup_fake_gh "[{\"number\":438,\"title\":\"Fresh\",\"updatedAt\":\"$FRESH\",\"url\":\"https://example.com/438\"},{\"number\":999,\"title\":\"Stale\",\"updatedAt\":\"$STALE2\",\"url\":\"https://example.com/999\"}]"
run_hook
assert_contains "$OUT" "#999" "staleなissue番号が含まれる"
if printf '%s' "$OUT" | grep -qF '#438'; then
  echo "  NG: freshなissueが含まれてはいけない"
  fail=1
else
  echo "  OK: freshなissueは含まれない"
fi

echo "=== scenario 5: BLOCKED_ISSUE_STALE_DAYSで閾値を変更できる ==="
CUSTOM="$(days_ago_iso 40)"
setup_fake_gh "[{\"number\":438,\"title\":\"Test\",\"updatedAt\":\"$CUSTOM\",\"url\":\"https://example.com/438\"}]"
set +e
OUT="$(PATH="$FAKE_BIN:$PATH" BLOCKED_ISSUE_STALE_DAYS=30 bash "$SCRIPT" < /dev/null)"
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "#438" "閾値を30日に下げると40日前のissueが警告対象になる"

echo "=== scenario 6: ghコマンドが無い環境 → 何も出力しない ==="
setup_fake_gh '[]' "0"
REAL_GH="$(command -v gh || true)"
GH_DIR="$(dirname "$REAL_GH" 2>/dev/null || true)"
PATH_WITHOUT_GH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -vF "$GH_DIR" | tr '\n' ':')"
set +e
OUT="$(PATH="$FAKE_BIN:$PATH_WITHOUT_GH" bash "$SCRIPT" < /dev/null)"
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
