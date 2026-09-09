#!/bin/bash
# scripts/check-verify-claims-fail-open-streak.sh の回帰テスト(issue #355)
# 実行: bash scripts/check-verify-claims-fail-open-streak.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-verify-claims-fail-open-streak.sh"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

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

write_entry() {
  local log_file="$1" event="$2" verifier_called="$3"
  jq -nc --arg event "$event" --argjson vc "$verifier_called" \
    '{timestamp: "2026-07-15T00:00:00Z", session_id: "t", event: $event, verifier_called: $vc}' \
    >> "$log_file"
}

echo "=== scenario 1: ログファイルが存在しない → exit 0 ==="
set +e
bash "$SCRIPT" --log-file "$WORKDIR/does-not-exist.jsonl" > /dev/null 2>&1
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "0" "ログファイル不在はexit 0(クラッシュしない)"

echo "=== scenario 2: verifier_called=true件数が閾値未満 → exit 0(スキップ) ==="
LOG2="$WORKDIR/log2.jsonl"
write_entry "$LOG2" "fail_open" true
write_entry "$LOG2" "fail_open" true
set +e
OUT="$(bash "$SCRIPT" --log-file "$LOG2" --streak-threshold 5 2>&1)"
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "0" "閾値未満はexit 0"
if printf '%s' "$OUT" | grep -qF "スキップ"; then
  echo "  OK: スキップの旨が出力される"
else
  echo "  NG: スキップの旨が出力されない (actual=$OUT)"
  fail=1
fi

echo "=== scenario 3: 直近N件が連続fail_open → exit 1(警告) ==="
LOG3="$WORKDIR/log3.jsonl"
write_entry "$LOG3" "block" true
for i in 1 2 3; do write_entry "$LOG3" "fail_open" true; done
set +e
OUT="$(bash "$SCRIPT" --log-file "$LOG3" --streak-threshold 3 2>&1)"
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "1" "直近N件が連続fail_openはexit 1"
if printf '%s' "$OUT" | grep -qF "警告"; then
  echo "  OK: 警告メッセージが出力される"
else
  echo "  NG: 警告メッセージが出力されない (actual=$OUT)"
  fail=1
fi

echo "=== scenario 4: 直近N件の途中にfail_open以外が混じる → exit 0 ==="
LOG4="$WORKDIR/log4.jsonl"
write_entry "$LOG4" "fail_open" true
write_entry "$LOG4" "pass" true
write_entry "$LOG4" "fail_open" true
set +e
bash "$SCRIPT" --log-file "$LOG4" --streak-threshold 3 > /dev/null 2>&1
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "0" "連続していなければexit 0"

echo "=== scenario 5: verifier_called=falseの行(同一diff再ブロック等)は連続判定から除外される ==="
LOG5="$WORKDIR/log5.jsonl"
write_entry "$LOG5" "fail_open" true
write_entry "$LOG5" "fail_open" true
write_entry "$LOG5" "block" false
write_entry "$LOG5" "block" false
write_entry "$LOG5" "fail_open" true
set +e
bash "$SCRIPT" --log-file "$LOG5" --streak-threshold 3 > /dev/null 2>&1
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "1" "verifier_called=falseの行を除外した上でverifier_called=trueが3連続fail_openならexit 1"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
