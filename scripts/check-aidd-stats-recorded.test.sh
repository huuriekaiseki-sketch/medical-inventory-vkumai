#!/bin/bash
# WHY: scripts/check-aidd-stats-recorded.sh（issue #495のStop hook）の回帰テスト。
# 実skeletonログ・実statsファイル・実transcriptに依存させず、一時ディレクトリの
# フェイクファイル群を環境変数で注入して決定的に検証する
# （check-gap-check-state.test.sh等と同じパターン）。
#
# 実行: bash scripts/check-aidd-stats-recorded.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-aidd-stats-recorded.sh"

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

SKELETON="$WORK_DIR/skeleton.jsonl"
STATS_DIR="$WORK_DIR/stats"
MARKER="$WORK_DIR/marker.json"
TRANSCRIPT="$WORK_DIR/transcript.jsonl"
mkdir -p "$STATS_DIR"

SESSION="session-aaa"
OTHER_SESSION="session-bbb"

# セッション開始時刻: 2026-07-22T04:00:00Z = epoch 1784692800
SESSION_START_ISO="2026-07-22T04:00:00.123Z"
SESSION_START_EPOCH=1784692800

# statsファイルのキーはスクリプトのcwd（リポジトリルート）から算出されるため、
# テスト側でも同じ計算で予め求めておく
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATS_KEY="$(cd "$REPO_ROOT" && python3 -c 'import hashlib, os; print(hashlib.sha256(os.getcwd().encode()).hexdigest()[:16])')"

wf_event() {
  printf '{"timestamp":"%s","hookEvent":"SubagentStop","sessionId":"%s","agentId":"a1","agentTranscriptPath":"/home/u/.claude/projects/p/s/subagents/workflows/wf_abc123/agent-a1.jsonl"}\n' "$1" "$2"
}
non_wf_event() {
  printf '{"timestamp":"%s","hookEvent":"SubagentStop","sessionId":"%s","agentId":"a2","agentTranscriptPath":"/home/u/.claude/projects/p/s/subagents/agent-a2.jsonl"}\n' "$1" "$2"
}

setup_transcript() {
  printf '{"type":"user","timestamp":"%s"}\n' "$SESSION_START_ISO" > "$TRANSCRIPT"
}

run_hook() {
  set +e
  OUT="$(AIDD_STATS_CHECK_SESSION_ID="$SESSION" \
    AIDD_STATS_CHECK_TRANSCRIPT_PATH="$TRANSCRIPT" \
    AIDD_STATS_CHECK_SKELETON_LOG="$SKELETON" \
    AIDD_STATS_CHECK_STATS_DIR="$STATS_DIR" \
    AIDD_STATS_CHECK_MARKER_FILE="$MARKER" \
    bash "$SCRIPT" < /dev/null 2>&1)"
  EXIT_CODE=$?
  set -e
}

reset_env() {
  rm -f "$SKELETON" "$MARKER" "$STATS_DIR/$STATS_KEY.json"
  setup_transcript
}

echo "=== scenario 1: skeletonログ無し → 沈黙 ==="
reset_env
rm -f "$SKELETON"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: このセッションのwf_イベント無し（非Workflowイベントのみ） → 沈黙 ==="
reset_env
non_wf_event "$SESSION_START_ISO" "$SESSION" > "$SKELETON"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 3: 別セッションのwf_イベントのみ（sessionId不一致） → 沈黙 ==="
reset_env
wf_event "$SESSION_START_ISO" "$OTHER_SESSION" > "$SKELETON"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 4: wf_イベントあり・statsファイル無し → 警告＋マーカー作成 ==="
reset_env
wf_event "$SESSION_START_ISO" "$SESSION" > "$SKELETON"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0（block不可）"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "start" "start記録に関する警告が含まれる"
assert_contains "$OUT" "issue #495" "issue番号が含まれる"
assert_eq "$([ -f "$MARKER" ] && echo yes || echo no)" "yes" "警告済みマーカーが作成される"

echo "=== scenario 5: 警告済みマーカーあり（同一セッション） → 2回目は沈黙 ==="
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "2回目の出力は空である"

echo "=== scenario 6: マーカーは別セッションのもの → 警告する ==="
jq -n --arg sid "$OTHER_SESSION" '{sessionId: $sid}' > "$MARKER"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "別セッションのマーカーでは抑止されない"

echo "=== scenario 7: statsのstart時刻が前セッションの残骸（セッション開始より古い） → 警告 ==="
reset_env
wf_event "$SESSION_START_ISO" "$SESSION" > "$SKELETON"
jq -n --argjson at "$((SESSION_START_EPOCH - 7200))" '{session_start_at: $at}' > "$STATS_DIR/$STATS_KEY.json"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "古いstart記録は残骸として警告される"

echo "=== scenario 8: statsのstart時刻がセッション開始以降 → 沈黙 ==="
reset_env
wf_event "$SESSION_START_ISO" "$SESSION" > "$SKELETON"
jq -n --argjson at "$((SESSION_START_EPOCH + 300))" '{session_start_at: $at}' > "$STATS_DIR/$STATS_KEY.json"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "start記録済みなら沈黙する"

echo "=== scenario 9: session_start_atは無いがphase1_start_atが今セッション → 沈黙（フォールバック） ==="
reset_env
wf_event "$SESSION_START_ISO" "$SESSION" > "$SKELETON"
jq -n --argjson at "$((SESSION_START_EPOCH + 300))" '{phase1_start_at: $at}' > "$STATS_DIR/$STATS_KEY.json"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "phase1_start_atフォールバックで沈黙する"

echo "=== scenario 10: transcriptが読めない → 沈黙（fail-open） ==="
reset_env
wf_event "$SESSION_START_ISO" "$SESSION" > "$SKELETON"
rm -f "$TRANSCRIPT"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "判定不能時は沈黙する"

echo "=== scenario 11: transcript先頭行にtimestampが無い → 沈黙（fail-open） ==="
reset_env
wf_event "$SESSION_START_ISO" "$SESSION" > "$SKELETON"
printf '{"type":"summary"}\n' > "$TRANSCRIPT"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "timestamp欠損時は沈黙する"

echo "=== scenario 11b: transcript先頭行がtimestamp無しのbridge-sessionレコード → 2行目の時刻で判定し警告する ==="
# WHY: Remote Control 連携セッションの transcript は timestamp 無しの bridge-session 行で始まる（2026-09-05 実測）。
#      1 行目決め打ちだと開始時刻が取れず、この hook が無音で死ぬ
reset_env
wf_event "$SESSION_START_ISO" "$SESSION" > "$SKELETON"
printf '{"type":"bridge-session","sessionId":"%s"}\n{"type":"user","timestamp":"%s"}\n' "$SESSION" "$SESSION_START_ISO" > "$TRANSCRIPT"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "bridge-session行を読み飛ばして警告する"

echo "=== scenario 12: マーカーが書き込めない環境 → クラッシュせず警告は出す（exit 0） ==="
reset_env
wf_event "$SESSION_START_ISO" "$SESSION" > "$SKELETON"
READONLY_DIR="$WORK_DIR/readonly"
mkdir -p "$READONLY_DIR"
chmod 555 "$READONLY_DIR"
set +e
OUT="$(AIDD_STATS_CHECK_SESSION_ID="$SESSION" \
  AIDD_STATS_CHECK_TRANSCRIPT_PATH="$TRANSCRIPT" \
  AIDD_STATS_CHECK_SKELETON_LOG="$SKELETON" \
  AIDD_STATS_CHECK_STATS_DIR="$STATS_DIR" \
  AIDD_STATS_CHECK_MARKER_FILE="$READONLY_DIR/marker.json" \
  bash "$SCRIPT" < /dev/null 2>&1)"
EXIT_CODE=$?
set -e
chmod 755 "$READONLY_DIR"
assert_eq "$EXIT_CODE" "0" "exit 0（クラッシュしない・block不可の絶対要件）"
assert_contains "$OUT" "systemMessage" "マーカーが書けなくても警告は出る"

echo "=== scenario 13: skeletonログに壊れた行が混在 → 後続の正当なwf_イベントを見失わず警告する ==="
reset_env
{
  printf '{broken json line\n'
  wf_event "$SESSION_START_ISO" "$SESSION"
} > "$SKELETON"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "壊れた行があっても後続イベントで警告できる"

echo "=== scenario 14: 別キーのstatsファイルに今セッションのstart記録（cwdドリフト） → 沈黙 ==="
reset_env
wf_event "$SESSION_START_ISO" "$SESSION" > "$SKELETON"
jq -n --argjson at "$((SESSION_START_EPOCH + 100))" '{session_start_at: $at}' > "$STATS_DIR/otherkey0000000000.json"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "別キーでも今セッションのstartがあれば誤警告しない"
rm -f "$STATS_DIR/otherkey0000000000.json"

echo "=== scenario 15: transcriptのtimestampがZ以外（オフセット付き） → 沈黙（fail-open） ==="
reset_env
wf_event "$SESSION_START_ISO" "$SESSION" > "$SKELETON"
printf '{"type":"user","timestamp":"2026-07-22T13:00:00.123+09:00"}\n' > "$TRANSCRIPT"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "UTC(Z)以外の形式は信頼せず沈黙する"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
