#!/bin/bash
# WHY: scripts/check-aidd-phase-stats-recorded.sh（issue #524のStop hook）の回帰テスト。
# 実workflows記録ディレクトリ・実statsファイル・実transcriptに依存させず、一時ディレクトリの
# フェイクファイル群を環境変数で注入して決定的に検証する
# （check-aidd-stats-recorded.test.shと同じパターン）。
#
# 実行: bash scripts/check-aidd-phase-stats-recorded.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-aidd-phase-stats-recorded.sh"

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
STATS_DIR="$WORK_DIR/stats"
MARKER="$WORK_DIR/marker.json"
TRANSCRIPT="$WORK_DIR/transcript.jsonl"
mkdir -p "$STATS_DIR"

SESSION="session-aaa"

# セッション開始時刻: 2026-07-22T04:00:00Z = epoch 1784692800
SESSION_START_ISO="2026-07-22T04:00:00.123Z"
SESSION_START_EPOCH=1784692800

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATS_KEY="$(cd "$REPO_ROOT" && python3 -c 'import hashlib, os; print(hashlib.sha256(os.getcwd().encode()).hexdigest()[:16])')"

setup_transcript() {
  printf '{"type":"user","timestamp":"%s"}\n' "$SESSION_START_ISO" > "$TRANSCRIPT"
}

write_wf_result() {
  # $1: ファイル名, $2: phaseの値（jq経由で.result.stats.phaseに埋め込む）
  jq -n --arg phase "$2" '{result: {stats: {phase: $phase}}}' > "$WORKFLOWS_DIR/$1"
}

run_hook() {
  set +e
  OUT="$(AIDD_PHASE_STATS_CHECK_SESSION_ID="$SESSION" \
    AIDD_PHASE_STATS_CHECK_TRANSCRIPT_PATH="$TRANSCRIPT" \
    AIDD_PHASE_STATS_CHECK_WORKFLOWS_DIR="$WORKFLOWS_DIR" \
    AIDD_PHASE_STATS_CHECK_STATS_DIR="$STATS_DIR" \
    AIDD_PHASE_STATS_CHECK_MARKER_FILE="$MARKER" \
    bash "$SCRIPT" < /dev/null 2>&1)"
  EXIT_CODE=$?
  set -e
}

reset_env() {
  rm -rf "$WORKFLOWS_DIR"
  mkdir -p "$WORKFLOWS_DIR"
  rm -f "$MARKER" "$STATS_DIR/$STATS_KEY.json"
  setup_transcript
}

echo "=== scenario 1: workflowsディレクトリ無し → 沈黙 ==="
reset_env
rm -rf "$WORKFLOWS_DIR"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: workflowsディレクトリは空 → 沈黙 ==="
reset_env
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 3: phase1/phase2に無関係なwf_*.json → 沈黙 ==="
reset_env
jq -n '{result: {route: "something-else"}}' > "$WORKFLOWS_DIR/wf_unrelated.json"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 4: phase1形跡ありでstats記録無し → 警告＋マーカー作成 ==="
reset_env
write_wf_result "wf_a.json" "phase1"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0（block不可）"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "phase1" "phase1に関する警告が含まれる"
assert_contains "$OUT" "issue #524" "issue番号が含まれる"
assert_eq "$([ -f "$MARKER" ] && echo yes || echo no)" "yes" "警告済みマーカーが作成される"

echo "=== scenario 5: 警告済みマーカーあり（同一セッション） → 2回目は沈黙 ==="
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "2回目の出力は空である"

echo "=== scenario 6: マーカーは別セッションのもの → 警告する ==="
jq -n --arg sid "other-session" '{sessionId: $sid}' > "$MARKER"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "別セッションのマーカーでは抑止されない"

echo "=== scenario 7: phase1-metaルートでも文字列一致でphase1形跡ありと判定される ==="
reset_env
write_wf_result "wf_a.json" "phase1-meta"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "phase1-metaも近似判定でphase1扱いになる"

echo "=== scenario 8: phase1_end_atがセッション開始以降で記録済み → 沈黙 ==="
reset_env
write_wf_result "wf_a.json" "phase1"
jq -n --argjson at "$((SESSION_START_EPOCH + 300))" '{phase1_end_at: $at}' > "$STATS_DIR/$STATS_KEY.json"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "記録済みなら沈黙する"

echo "=== scenario 9: phase1_end_atが前セッションの残骸（セッション開始より古い） → 警告 ==="
reset_env
write_wf_result "wf_a.json" "phase1"
jq -n --argjson at "$((SESSION_START_EPOCH - 7200))" '{phase1_end_at: $at}' > "$STATS_DIR/$STATS_KEY.json"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "古い記録は残骸として警告される"

echo "=== scenario 10: phase2形跡ありでstats記録無し → 警告 ==="
reset_env
write_wf_result "wf_a.json" "phase2"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "phase2" "phase2に関する警告が含まれる"

echo "=== scenario 11: phase1は記録済み・phase2は未記録 → phase2のみ警告に含まれる ==="
reset_env
write_wf_result "wf_a.json" "phase1"
write_wf_result "wf_b.json" "phase2"
jq -n --argjson at "$((SESSION_START_EPOCH + 300))" '{phase1_end_at: $at}' > "$STATS_DIR/$STATS_KEY.json"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "phase2" "phase2の警告が含まれる"

echo "=== scenario 12: transcriptが読めない → 沈黙（fail-open） ==="
reset_env
write_wf_result "wf_a.json" "phase1"
rm -f "$TRANSCRIPT"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "判定不能時は沈黙する"

echo "=== scenario 13: transcriptのtimestampがZ以外 → 沈黙（fail-open） ==="
reset_env
write_wf_result "wf_a.json" "phase1"
printf '{"type":"user","timestamp":"2026-07-22T13:00:00.123+09:00"}\n' > "$TRANSCRIPT"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "UTC(Z)以外の形式は信頼せず沈黙する"

echo "=== scenario 14: マーカーが書き込めない環境 → クラッシュせず警告は出す（exit 0） ==="
reset_env
write_wf_result "wf_a.json" "phase1"
READONLY_DIR="$WORK_DIR/readonly"
mkdir -p "$READONLY_DIR"
chmod 555 "$READONLY_DIR"
set +e
OUT="$(AIDD_PHASE_STATS_CHECK_SESSION_ID="$SESSION" \
  AIDD_PHASE_STATS_CHECK_TRANSCRIPT_PATH="$TRANSCRIPT" \
  AIDD_PHASE_STATS_CHECK_WORKFLOWS_DIR="$WORKFLOWS_DIR" \
  AIDD_PHASE_STATS_CHECK_STATS_DIR="$STATS_DIR" \
  AIDD_PHASE_STATS_CHECK_MARKER_FILE="$READONLY_DIR/marker.json" \
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
