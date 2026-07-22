#!/bin/bash
# WHY: scripts/check-gap-check-state.sh（issue #488のStop hook本体）の回帰テスト。
# 実gap checkスクリプト・実stateファイルに依存させず、フェイクのgap checkコマンドと
# stateファイルを環境変数で注入して決定的に検証する
# （check-blocked-issues-staleness.test.shと同じパターン）。
#
# 実行: bash scripts/check-gap-check-state.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-gap-check-state.sh"

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
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  NG: $label (found: $needle)"
    fail=1
  else
    echo "  OK: $label"
  fi
}

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

STATE="$WORK_DIR/state.json"
LOOP_CMD="$WORK_DIR/fake-loop-gap.sh"
PROGRESS_CMD="$WORK_DIR/fake-progress-gap.sh"
LOOP_CALLED="$WORK_DIR/loop-called"
PROGRESS_CALLED="$WORK_DIR/progress-called"

# フェイクgap checkコマンド: 呼ばれたことと引数を記録し、指定の出力・exit codeを返す
setup_fake_cmd() {
  local path="$1" called_file="$2" output="$3" exit_code="$4"
  cat > "$path" <<EOF
#!/bin/bash
echo "\$@" > "$called_file"
echo '$output'
exit $exit_code
EOF
  chmod +x "$path"
}

run_hook() {
  rm -f "$LOOP_CALLED" "$PROGRESS_CALLED"
  set +e
  OUT="$(GAP_CHECK_STATE_FILE="$STATE" GAP_CHECK_LOOP_CMD="$LOOP_CMD" \
    GAP_CHECK_PROGRESS_CMD="$PROGRESS_CMD" GAP_CHECK_NOW_EPOCH=2000000 \
    bash "$SCRIPT" < /dev/null 2>&1)"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: stateファイル無し → 完全に沈黙 ==="
rm -f "$STATE"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: expected未記録・24時間以内 → 何もしない（stateも残る） ==="
jq -n '{beforeLoopObservability: 5, beforeAgentProgress: 19, recordedAt: 1999000}' > "$STATE"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"
assert_eq "$([ -f "$STATE" ] && echo kept || echo removed)" "kept" "stateファイルが残っている"

echo "=== scenario 3: expected未記録・閾値超え → 削除＋破棄警告 ==="
jq -n '{beforeLoopObservability: 5, beforeAgentProgress: 19, recordedAt: 1000000}' > "$STATE"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "破棄しました" "破棄の警告が含まれる"
assert_contains "$OUT" "未実施" "gap check未実施の明記がある"
assert_eq "$([ -f "$STATE" ] && echo kept || echo removed)" "removed" "stateファイルが削除されている"

echo "=== scenario 4: expected記録済み・両方gap無し → 沈黙してクリア ==="
jq -n '{beforeLoopObservability: 5, beforeAgentProgress: 19, recordedAt: 1999000, expectedLoopObservability: 10, expectedAgentProgress: 16}' > "$STATE"
setup_fake_cmd "$LOOP_CMD" "$LOOP_CALLED" '{"actualCount":10,"expectedCount":10,"hasGap":false}' 0
setup_fake_cmd "$PROGRESS_CMD" "$PROGRESS_CALLED" '{"actualCount":16,"expectedCount":16,"hasGap":false}' 0
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "警告が出ない"
assert_eq "$([ -f "$STATE" ] && echo kept || echo removed)" "removed" "stateファイルがクリアされている"
assert_eq "$(cat "$LOOP_CALLED")" "--before 5 --expected 10" "loop checkにbefore/expectedが渡っている"
assert_eq "$(cat "$PROGRESS_CALLED")" "--before 19 --expected 16" "progress checkにbefore/expectedが渡っている"

echo "=== scenario 5: loop側にgap有り → systemMessage警告＋クリア ==="
jq -n '{beforeLoopObservability: 5, beforeAgentProgress: 19, recordedAt: 1999000, expectedLoopObservability: 10, expectedAgentProgress: 16}' > "$STATE"
setup_fake_cmd "$LOOP_CMD" "$LOOP_CALLED" '{"actualCount":4,"expectedCount":10,"hasGap":true}' 1
setup_fake_cmd "$PROGRESS_CMD" "$PROGRESS_CALLED" '{"actualCount":16,"expectedCount":16,"hasGap":false}' 0
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0（warningのみ・block不可）"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "記録漏れ" "記録漏れ警告が含まれる"
assert_contains "$OUT" "loop-observability" "どのログのgapかが含まれる"
assert_contains "$OUT" "hasGap" "gap check出力が引用されている"
assert_eq "$([ -f "$STATE" ] && echo kept || echo removed)" "removed" "stateファイルがクリアされている"

echo "=== scenario 6: agent-progressのexpectedのみ記録 → loop checkは呼ばれない ==="
jq -n '{beforeLoopObservability: 5, beforeAgentProgress: 19, recordedAt: 1999000, expectedAgentProgress: 4}' > "$STATE"
setup_fake_cmd "$LOOP_CMD" "$LOOP_CALLED" '{"hasGap":false}' 0
setup_fake_cmd "$PROGRESS_CMD" "$PROGRESS_CALLED" '{"actualCount":4,"expectedCount":4,"hasGap":false}' 0
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_eq "$([ -f "$LOOP_CALLED" ] && echo called || echo not-called)" "not-called" "loop checkは呼ばれない"
assert_eq "$([ -f "$PROGRESS_CALLED" ] && echo called || echo not-called)" "called" "progress checkは呼ばれる"

echo "=== scenario 7: recordedAtが非数値（state破損） → クラッシュせず破棄＋警告 ==="
jq -n '{beforeLoopObservability: 5, beforeAgentProgress: 19, recordedAt: "not-a-number"}' > "$STATE"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0（クラッシュしない）"
assert_contains "$OUT" "破棄しました" "破棄の警告が含まれる"
assert_eq "$([ -f "$STATE" ] && echo kept || echo removed)" "removed" "stateファイルが削除されている（毎ターン再クラッシュしない）"

echo "=== scenario 8: gap checkの実行自体が失敗（hasGap出力なしでexit 1） → gap警告と区別された文言 ==="
jq -n '{beforeLoopObservability: 5, beforeAgentProgress: 19, recordedAt: 1999000, expectedLoopObservability: 10}' > "$STATE"
setup_fake_cmd "$LOOP_CMD" "$LOOP_CALLED" 'npx: network error' 1
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "実行自体に失敗" "実行失敗の文言が含まれる"
assert_contains "$OUT" "未判定" "gap有無は未判定である旨が含まれる"
assert_not_contains "$OUT" "記録漏れ（またはズレ）の可能性があります" "本物のgap警告文言とは区別されている"
assert_eq "$([ -f "$STATE" ] && echo kept || echo removed)" "removed" "stateファイルはクリアされる"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
