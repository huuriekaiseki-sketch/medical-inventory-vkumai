#!/bin/bash
# WHY: scripts/log-find-av-precision.sh の回帰テスト（issue #432）。
#
# 実行: bash scripts/log-find-av-precision.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/log-find-av-precision.sh"

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

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT
LOG_FILE="$TMPDIR_TEST/find-av-precision.jsonl"

echo "=== scenario 1: 正常なJSONを渡すと1行追記される ==="
bash "$SCRIPT" --feature admin-role --log-file "$LOG_FILE" '{"findCount":3,"verifiedCount":2,"survivedCount":1,"autoSurvivedMinorCount":1,"survivalRate":0.5,"byLens":{"logic":{"verified":2,"survived":1}}}'
LINE_COUNT="$(wc -l < "$LOG_FILE" | tr -d ' ')"
assert_eq "$LINE_COUNT" "1" "1行追記される"
CONTENT="$(cat "$LOG_FILE")"
assert_contains "$CONTENT" '"feature":"admin-role"' "featureが記録される"
assert_contains "$CONTENT" '"verifiedCount":2' "統計フィールドがそのまま展開される"
assert_contains "$CONTENT" '"timestamp"' "timestampが付与される"

echo "=== scenario 2: 不正なJSONはエラーで拒否する ==="
set +e
OUT="$(bash "$SCRIPT" --feature admin-role --log-file "$LOG_FILE" 'not-json' 2>&1)"
EXIT_CODE=$?
set -e
if [ "$EXIT_CODE" -ne 0 ]; then
  echo "  OK: 不正なJSONで非0終了する"
else
  echo "  NG: 不正なJSONでも0終了してしまった"
  fail=1
fi

echo "=== scenario 3: --featureが無いとusageで終了する ==="
set +e
bash "$SCRIPT" --log-file "$LOG_FILE" '{"findCount":1}' > /dev/null 2>&1
EXIT_CODE=$?
set -e
if [ "$EXIT_CODE" -ne 0 ]; then
  echo "  OK: --feature省略時に非0終了する"
else
  echo "  NG: --feature省略時も0終了してしまった"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
