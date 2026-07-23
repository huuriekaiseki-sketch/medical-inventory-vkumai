#!/bin/bash
# WHY: scripts/check-find-av-precision-recorded.sh（issue #522のStop hook）の回帰テスト。
# 実workflows記録ディレクトリ・実ログファイル・実transcriptに依存させず、一時ディレクトリの
# フェイクファイル群を環境変数で注入して決定的に検証する
# （check-aidd-phase-stats-recorded.test.shと同じパターン）。
#
# 実行: bash scripts/check-find-av-precision-recorded.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-find-av-precision-recorded.sh"

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
assert_empty() {
  local actual="$1" label="$2"
  if [ -z "$actual" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (actual=$actual)"
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

WORKFLOWS_DIR="$WORK_DIR/workflows"
MARKER="$WORK_DIR/marker.json"
TRANSCRIPT="$WORK_DIR/transcript.jsonl"
LOG_FILE="$WORK_DIR/find-av-precision.jsonl"
mkdir -p "$WORKFLOWS_DIR"

SESSION="session-aaa"

# セッション開始時刻: 2026-07-22T04:00:00Z = epoch 1784692800
SESSION_START_ISO="2026-07-22T04:00:00.123Z"
SESSION_START_EPOCH=1784692800

setup_transcript() {
  printf '{"type":"user","timestamp":"%s"}\n' "$SESSION_START_ISO" > "$TRANSCRIPT"
}

write_wf_with_precision() {
  # $1: ファイル名, $2: verifiedCount
  jq -n --argjson vc "$2" '{result: {findAvPrecision: {verifiedCount: $vc}}}' > "$WORKFLOWS_DIR/$1"
}

run_hook() {
  set +e
  OUT="$(FIND_AV_PRECISION_CHECK_SESSION_ID="$SESSION" \
    FIND_AV_PRECISION_CHECK_TRANSCRIPT_PATH="$TRANSCRIPT" \
    FIND_AV_PRECISION_CHECK_WORKFLOWS_DIR="$WORKFLOWS_DIR" \
    FIND_AV_PRECISION_CHECK_LOG_FILE="$LOG_FILE" \
    FIND_AV_PRECISION_CHECK_MARKER_FILE="$MARKER" \
    bash "$SCRIPT" < /dev/null 2>&1)"
  EXIT_CODE=$?
  set -e
}

reset_env() {
  rm -rf "$WORKFLOWS_DIR"
  mkdir -p "$WORKFLOWS_DIR"
  rm -f "$MARKER" "$LOG_FILE"
  setup_transcript
}

echo "=== scenario 1: workflowsディレクトリが空 → 沈黙 ==="
reset_env
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: verifiedCount=0のみ（検証対象が無かった） → 沈黙 ==="
reset_env
write_wf_with_precision "wf_a.json" 0
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 3: verifiedCount>0でログ記録無し → 警告＋マーカー作成 ==="
reset_env
write_wf_with_precision "wf_a.json" 3
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0（block不可）"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "issue #522" "issue番号が含まれる"
assert_eq "$([ -f "$MARKER" ] && echo yes || echo no)" "yes" "警告済みマーカーが作成される"

echo "=== scenario 4: 警告済みマーカーあり（同一セッション） → 2回目は沈黙 ==="
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "2回目の出力は空である"

echo "=== scenario 5: マーカーは別セッションのもの → 警告する ==="
jq -n --arg sid "other-session" '{sessionId: $sid}' > "$MARKER"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "別セッションのマーカーでは抑止されない"

echo "=== scenario 6: ログがセッション開始以降に記録済み → 沈黙 ==="
reset_env
write_wf_with_precision "wf_a.json" 3
RECENT_ISO="2026-07-22T04:10:00Z"
printf '{"timestamp":"%s","feature":"x"}\n' "$RECENT_ISO" > "$LOG_FILE"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "記録済みなら沈黙する"

echo "=== scenario 7: ログが前セッションの残骸（セッション開始より古い） → 警告 ==="
reset_env
write_wf_with_precision "wf_a.json" 3
OLD_ISO="2026-07-22T02:00:00Z"
printf '{"timestamp":"%s","feature":"x"}\n' "$OLD_ISO" > "$LOG_FILE"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "古い記録は残骸として警告される"

echo "=== scenario 8: transcriptが読めない → 沈黙（fail-open） ==="
reset_env
write_wf_with_precision "wf_a.json" 3
rm -f "$TRANSCRIPT"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "判定不能時は沈黙する"

echo "=== scenario 9: マーカーが書き込めない環境 → クラッシュせず警告は出す（exit 0） ==="
reset_env
write_wf_with_precision "wf_a.json" 3
READONLY_DIR="$WORK_DIR/readonly"
mkdir -p "$READONLY_DIR"
chmod 555 "$READONLY_DIR"
set +e
OUT="$(FIND_AV_PRECISION_CHECK_SESSION_ID="$SESSION" \
  FIND_AV_PRECISION_CHECK_TRANSCRIPT_PATH="$TRANSCRIPT" \
  FIND_AV_PRECISION_CHECK_WORKFLOWS_DIR="$WORKFLOWS_DIR" \
  FIND_AV_PRECISION_CHECK_LOG_FILE="$LOG_FILE" \
  FIND_AV_PRECISION_CHECK_MARKER_FILE="$READONLY_DIR/marker.json" \
  bash "$SCRIPT" < /dev/null 2>&1)"
EXIT_CODE=$?
set -e
chmod 755 "$READONLY_DIR"
assert_eq "$EXIT_CODE" "0" "exit 0（クラッシュしない・block不可の絶対要件）"
assert_contains "$OUT" "systemMessage" "マーカーが書けなくても警告は出る"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
