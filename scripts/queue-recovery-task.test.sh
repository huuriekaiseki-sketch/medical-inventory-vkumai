#!/bin/bash
# WHY: scripts/queue-recovery-task.sh（issue #523）の回帰テスト。
# 実キューファイルに依存させず、一時ディレクトリのフェイクファイルで決定的に検証する。
#
# 実行: bash scripts/queue-recovery-task.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/queue-recovery-task.sh"

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

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

QUEUE_FILE="$WORK_DIR/recovery-queue.jsonl"

echo "=== scenario 1: 正常な呼び出し → 1行追記される ==="
rm -f "$QUEUE_FILE"
bash "$SCRIPT" --type "gap-check-followup" --detail '{"foo":"bar"}' --queue-file "$QUEUE_FILE"
assert_eq "$(wc -l < "$QUEUE_FILE" | tr -d ' ')" "1" "1行追記されている"
LINE="$(cat "$QUEUE_FILE")"
assert_contains "$LINE" '"type":"gap-check-followup"' "typeが記録される"
assert_contains "$LINE" '"status":"pending"' "statusはpendingで記録される"
assert_contains "$LINE" '"foo":"bar"' "detailが記録される"

echo "=== scenario 2: 複数回呼び出し → 追記される（既存行は消えない） ==="
bash "$SCRIPT" --type "another-type" --detail '{"x":1}' --queue-file "$QUEUE_FILE"
assert_eq "$(wc -l < "$QUEUE_FILE" | tr -d ' ')" "2" "2行になっている"

echo "=== scenario 3: --typeが無い → エラー終了 ==="
set +e
bash "$SCRIPT" --detail '{"x":1}' --queue-file "$QUEUE_FILE" > /dev/null 2>&1
CODE=$?
set -e
assert_eq "$CODE" "1" "--type無しはexit 1"

echo "=== scenario 4: --detailが不正なJSON → エラー終了 ==="
set +e
bash "$SCRIPT" --type "x" --detail 'not-json' --queue-file "$QUEUE_FILE" > /dev/null 2>&1
CODE=$?
set -e
assert_eq "$CODE" "1" "不正JSONはexit 1"

echo "=== scenario 5: キューファイルの親ディレクトリが無い → 自動作成される ==="
NESTED_QUEUE="$WORK_DIR/nested/dir/recovery-queue.jsonl"
bash "$SCRIPT" --type "x" --detail '{}' --queue-file "$NESTED_QUEUE"
assert_eq "$([ -f "$NESTED_QUEUE" ] && echo yes || echo no)" "yes" "親ディレクトリが自動作成されファイルが書ける"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
