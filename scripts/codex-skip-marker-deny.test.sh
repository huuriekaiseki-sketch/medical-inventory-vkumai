#!/bin/bash
# WHY: Codex用ask→deny変換ラッパー(scripts/codex-skip-marker-deny.sh)の回帰テスト。
# CodexのPreToolUseはpermissionDecision: "ask"未対応（riff-gear実機検証）のため、
# Claude側でaskのガード(check-skip-marker-write.sh)をCodexに登録する際はdenyへ
# 読み替える必要がある。askのまま素通りすると、Codex経由でClaude側の検証機構
# (.claude/.verify-state のskipマーカー)を無確認で書き換えられる抜け穴になる。
#
# 実行: bash scripts/codex-skip-marker-deny.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/codex-skip-marker-deny.sh"

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
    echo "  NG: $label (found: $needle)"
    fail=1
  else
    echo "  OK: $label"
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

run_hook() {
  local input="$1"
  set +e
  OUT="$(printf '%s' "$input" | bash "$SCRIPT")"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: skipマーカーへのBash書き込み → deny（askではなく） ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "touch .claude/.verify-state/abc.skip"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "denyが出力される"
assert_not_contains "$OUT" '"permissionDecision": "ask"' "askが残っていない（Codexはask未対応）"

echo "=== scenario 2: skipマーカーへのWrite → deny ==="
input="$(jq -n '{tool_name: "Write", tool_input: {file_path: ".claude/.verify-state/session123.skip"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "denyが出力される"

echo "=== scenario 3: 無関係なコマンド → 何も出力しない ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "npm test"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 4: jq未インストール環境 → fail-closed(exit 2) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "touch .claude/.verify-state/abc.skip"}}')"
set +e
OUT="$(printf '%s' "$input" | PATH="" /bin/bash "$SCRIPT" 2>&1)"
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "2" "exit 2(fail-closed)"

echo "=== scenario 5: deny理由にCodex向けの読み替え説明が含まれる（人間の手動実行を促す） ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "touch .claude/.verify-state/abc.skip"}}')"
run_hook "$input"
assert_contains "$OUT" 'Codex' "理由文にCodex読み替えの説明がある"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
