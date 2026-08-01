#!/bin/bash
# WHY: scripts/resolve-recovery-task.sh（issue #579）の回帰テスト。
# 実キューファイルに依存させず、一時ディレクトリのフェイクファイルで決定的に検証する。
#
# 実行: bash scripts/resolve-recovery-task.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/resolve-recovery-task.sh"

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

echo "=== scenario 1: 対象idがresolvedに書き換わり、他行は無変更 ==="
{
  jq -nc '{id: "a", timestamp: "2026-07-23T00:00:00Z", type: "gap-check-followup", detail: {}, status: "surfaced", surfacedAt: "2026-07-23T00:01:00Z"}'
  jq -nc '{id: "b", timestamp: "2026-07-23T00:02:00Z", type: "gap-check-followup", detail: {}, status: "pending"}'
} > "$QUEUE_FILE"
OUT="$(bash "$SCRIPT" --id "a" --queue-file "$QUEUE_FILE")"
assert_contains "$OUT" "Resolved: a" "解決したidが出力される"
STATUS_A="$(jq -R -r 'fromjson? | select(.id == "a") | .status' "$QUEUE_FILE")"
assert_eq "$STATUS_A" "resolved" "対象idのstatusがresolvedになる"
RESOLVED_AT="$(jq -R -r 'fromjson? | select(.id == "a") | .resolvedAt' "$QUEUE_FILE")"
assert_eq "$([ -n "$RESOLVED_AT" ] && [ "$RESOLVED_AT" != "null" ] && echo yes || echo no)" "yes" "resolvedAtが記録される"
STATUS_B="$(jq -R -r 'fromjson? | select(.id == "b") | .status' "$QUEUE_FILE")"
assert_eq "$STATUS_B" "pending" "他の行は無変更のまま"

echo "=== scenario 2: 存在しないid → エラー終了 ==="
set +e
OUT="$(bash "$SCRIPT" --id "nonexistent" --queue-file "$QUEUE_FILE" 2>&1)"
CODE=$?
set -e
assert_eq "$CODE" "1" "存在しないidはexit 1"
assert_contains "$OUT" "No entry found" "エラーメッセージが出る"

echo "=== scenario 3: --idが無い → エラー終了 ==="
set +e
bash "$SCRIPT" --queue-file "$QUEUE_FILE" > /dev/null 2>&1
CODE=$?
set -e
assert_eq "$CODE" "1" "--id無しはexit 1"

echo "=== scenario 4: キューファイルが存在しない → エラー終了 ==="
set +e
bash "$SCRIPT" --id "a" --queue-file "$WORK_DIR/nonexistent.jsonl" > /dev/null 2>&1
CODE=$?
set -e
assert_eq "$CODE" "1" "キューファイル無しはexit 1"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
