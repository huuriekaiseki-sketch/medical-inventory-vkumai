#!/bin/bash
# WHY: scripts/check-workflow-interruption.sh(SessionStart hook、issue #534)の回帰テスト。
# 実物の~/.claude/projects/を使わず、WORKFLOW_INTERRUPTION_PROJECT_ROOT等の環境変数注入
# ポイントでフェイクのwf_*.json fixtureを指すよう差し替えて決定的に検証する
# （check-local-main-freshness.test.shと同型）。
#
# 実行: bash scripts/check-workflow-interruption.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-workflow-interruption.sh"

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
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  NG: $label"
    echo "      expected NOT to find: $needle"
    echo "      actual: $haystack"
    fail=1
  else
    echo "  OK: $label"
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
trap 'rm -rf "$WORKDIR"' EXIT

WF_ROOT="$WORKDIR/project-root"
SESSION_DIR="$WF_ROOT/fake-session/workflows"
mkdir -p "$SESSION_DIR"

# set_mtime <file> <hoursAgo>  (macOS/Linux両対応のためpython3で設定)
set_mtime() {
  local path="$1" hours_ago="$2"
  python3 -c "
import os, time
path = '$path'
old = time.time() - $hours_ago * 3600
os.utime(path, (old, old))
"
}

write_wf() {
  local name="$1" run_id="$2" status="$3"
  cat > "$SESSION_DIR/$name" <<EOF
{"runId":"$run_id","workflowName":"test-wf","status":"$status"}
EOF
}

# EXTRA_ENV_STR: 追加の環境変数(例: "WORKFLOW_INTERRUPTION_STALE_HOURS=10")。
# 未使用時は空文字。配列ではなくプレーン文字列にしているのは、bash 3.2系で
# 空配列を`set -u`下で展開すると"unbound variable"になる既知の非互換を避けるため
# （このテストの値は全て自前で組み立てた既知の内容のみのためunquoted展開でも安全）
EXTRA_ENV_STR=""
run_hook() {
  local queue_file="$WORKDIR/queue-$$-$RANDOM.jsonl"
  local seen_file="$WORKDIR/seen-$$-$RANDOM"
  rm -f "$queue_file" "$seen_file"
  set +e
  env WORKFLOW_INTERRUPTION_PROJECT_ROOT="$WF_ROOT" \
    RECOVERY_QUEUE_FILE="$queue_file" \
    WORKFLOW_INTERRUPTION_SEEN_FILE="$seen_file" \
    $EXTRA_ENV_STR \
    bash "$SCRIPT" < /dev/null
  EXIT_CODE=$?
  set -e
  QUEUE_FILE_OUT="$queue_file"
  SEEN_FILE_OUT="$seen_file"
  OUT="$(cat "$queue_file" 2>/dev/null || true)"
}

echo "=== scenario 1: status=killed → staleness閾値に関わらず即座に対象になる ==="
rm -rf "$SESSION_DIR"; mkdir -p "$SESSION_DIR"
write_wf "wf_killed.json" "wf_killed-1" "killed"
set_mtime "$SESSION_DIR/wf_killed.json" 0
EXTRA_ENV_STR=""
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "wf_killed-1" "killedのrunIdがキューに登録される"
assert_contains "$OUT" "workflow-interrupted" "typeがworkflow-interruptedである"

echo "=== scenario 2: status=completed → 対象にならない ==="
rm -rf "$SESSION_DIR"; mkdir -p "$SESSION_DIR"
write_wf "wf_done.json" "wf_done-1" "completed"
set_mtime "$SESSION_DIR/wf_done.json" 100
EXTRA_ENV_STR=""
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_eq "$OUT" "" "completedはキューに登録されない(100時間経過していても)"

echo "=== scenario 3: status=running かつ mtimeが閾値(既定4時間)より新しい → 対象にならない ==="
rm -rf "$SESSION_DIR"; mkdir -p "$SESSION_DIR"
write_wf "wf_fresh.json" "wf_fresh-1" "running"
set_mtime "$SESSION_DIR/wf_fresh.json" 1
EXTRA_ENV_STR=""
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_eq "$OUT" "" "1時間前のrunningは(既定4時間閾値では)対象にならない"

echo "=== scenario 4: status=running かつ mtimeが閾値より古い → staleness近似で対象になる ==="
rm -rf "$SESSION_DIR"; mkdir -p "$SESSION_DIR"
write_wf "wf_stale.json" "wf_stale-1" "running"
set_mtime "$SESSION_DIR/wf_stale.json" 5
EXTRA_ENV_STR=""
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "wf_stale-1" "5時間前のrunningは(既定4時間閾値では)対象になる"

echo "=== scenario 5: WORKFLOW_INTERRUPTION_STALE_HOURSで閾値を変更できる ==="
rm -rf "$SESSION_DIR"; mkdir -p "$SESSION_DIR"
write_wf "wf_stale2.json" "wf_stale2-1" "running"
set_mtime "$SESSION_DIR/wf_stale2.json" 5
EXTRA_ENV_STR="WORKFLOW_INTERRUPTION_STALE_HOURS=10"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_eq "$OUT" "" "閾値を10時間に上げると5時間前のrunningは対象にならない"

echo "=== scenario 6: 重複登録防止(dedup) — 同じrunIdは2回登録されない ==="
rm -rf "$SESSION_DIR"; mkdir -p "$SESSION_DIR"
write_wf "wf_dup.json" "wf_dup-1" "killed"
set_mtime "$SESSION_DIR/wf_dup.json" 0
QUEUE_FILE="$WORKDIR/dedup-queue.jsonl"
SEEN_FILE="$WORKDIR/dedup-seen"
rm -f "$QUEUE_FILE" "$SEEN_FILE"
WORKFLOW_INTERRUPTION_PROJECT_ROOT="$WF_ROOT" RECOVERY_QUEUE_FILE="$QUEUE_FILE" WORKFLOW_INTERRUPTION_SEEN_FILE="$SEEN_FILE" bash "$SCRIPT" < /dev/null > /dev/null
WORKFLOW_INTERRUPTION_PROJECT_ROOT="$WF_ROOT" RECOVERY_QUEUE_FILE="$QUEUE_FILE" WORKFLOW_INTERRUPTION_SEEN_FILE="$SEEN_FILE" bash "$SCRIPT" < /dev/null > /dev/null
DUP_COUNT="$(grep -c "wf_dup-1" "$QUEUE_FILE" 2>/dev/null || echo 0)"
assert_eq "$DUP_COUNT" "1" "2回実行してもキューに1件しか登録されない"

echo "=== scenario 7: SEEN_FILEが直近WORKFLOW_INTERRUPTION_SEEN_MAX件のみ保持される ==="
rm -rf "$SESSION_DIR"; mkdir -p "$SESSION_DIR"
write_wf "wf_rot.json" "wf_rot-new" "killed"
set_mtime "$SESSION_DIR/wf_rot.json" 0
QUEUE_FILE="$WORKDIR/rot-queue.jsonl"
SEEN_FILE="$WORKDIR/rot-seen"
rm -f "$QUEUE_FILE"
# あらかじめSEEN_FILEにダミーのrunIdを10件仕込んでおく(2桁ゼロ埋め:
# wf_dummy-01がwf_dummy-10の部分文字列として誤検知されるのを避けるため)
for i in $(seq 1 10); do printf 'wf_dummy-%02d\n' "$i"; done > "$SEEN_FILE"
WORKFLOW_INTERRUPTION_PROJECT_ROOT="$WF_ROOT" RECOVERY_QUEUE_FILE="$QUEUE_FILE" WORKFLOW_INTERRUPTION_SEEN_FILE="$SEEN_FILE" WORKFLOW_INTERRUPTION_SEEN_MAX=5 bash "$SCRIPT" < /dev/null > /dev/null
SEEN_LINE_COUNT="$(wc -l < "$SEEN_FILE" | tr -d ' ')"
assert_eq "$SEEN_LINE_COUNT" "5" "SEEN_MAX=5を超えた分は切り詰められる"
assert_contains "$(cat "$SEEN_FILE")" "wf_rot-new" "直近追加されたrunIdは残る"
assert_not_contains "$(cat "$SEEN_FILE")" "wf_dummy-01" "最も古いダミーrunIdは切り詰められて消える"

echo "=== scenario 8: stat取得に失敗する環境 → fail-open(staleness判定をスキップ・対象にならない) ==="
FAKE_BIN="$WORKDIR/fake-bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/stat" <<'EOF'
#!/bin/bash
exit 1
EOF
chmod +x "$FAKE_BIN/stat"
rm -rf "$SESSION_DIR"; mkdir -p "$SESSION_DIR"
write_wf "wf_nostat.json" "wf_nostat-1" "running"
set_mtime "$SESSION_DIR/wf_nostat.json" 100
QUEUE_FILE="$WORKDIR/nostat-queue.jsonl"
SEEN_FILE="$WORKDIR/nostat-seen"
rm -f "$QUEUE_FILE" "$SEEN_FILE"
set +e
PATH="$FAKE_BIN:$PATH" WORKFLOW_INTERRUPTION_PROJECT_ROOT="$WF_ROOT" RECOVERY_QUEUE_FILE="$QUEUE_FILE" WORKFLOW_INTERRUPTION_SEEN_FILE="$SEEN_FILE" bash "$SCRIPT" < /dev/null
NOSTAT_EXIT=$?
set -e
NOSTAT_OUT="$(cat "$QUEUE_FILE" 2>/dev/null || true)"
assert_eq "$NOSTAT_EXIT" "0" "stat失敗環境でもexit 0(block不可)"
assert_eq "$NOSTAT_OUT" "" "stat失敗時はfail-openで対象にならない(epoch 0への誤フォールバックでの誤検知が無い)"

echo "=== scenario 9: 対象のwf_*.jsonが1件も無い → 何もせずexit 0 ==="
rm -rf "$SESSION_DIR"; mkdir -p "$SESSION_DIR"
QUEUE_FILE="$WORKDIR/empty-queue.jsonl"
SEEN_FILE="$WORKDIR/empty-seen"
rm -f "$QUEUE_FILE" "$SEEN_FILE"
set +e
WORKFLOW_INTERRUPTION_PROJECT_ROOT="$WF_ROOT" RECOVERY_QUEUE_FILE="$QUEUE_FILE" WORKFLOW_INTERRUPTION_SEEN_FILE="$SEEN_FILE" bash "$SCRIPT" < /dev/null
EMPTY_EXIT=$?
set -e
assert_eq "$EMPTY_EXIT" "0" "exit 0"
assert_eq "$([ -f "$QUEUE_FILE" ] && cat "$QUEUE_FILE" || echo '')" "" "何も登録されない"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
