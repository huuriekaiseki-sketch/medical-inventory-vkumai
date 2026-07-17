#!/bin/bash
# WHY: scripts/check-automode-config.sh(SessionStart hook)の回帰テスト。
# 個人設定(~/.claude/settings.json相当)にautoMode.hard_denyが無ければ警告し、
# 有れば何も出力しないことを確認する。CLAUDE_USER_SETTINGS_PATHでテスト用パスに
# 差し替える（本物の$HOME/.claude/settings.jsonを書き換えないため）。
#
# 実行: bash scripts/check-automode-config.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-automode-config.sh"

fail=0
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

TMPDIR_TEST="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT

echo "=== scenario 1: 設定ファイルが存在しない → 警告する ==="
OUT="$(CLAUDE_USER_SETTINGS_PATH="$TMPDIR_TEST/no-such-file.json" bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "autoMode" "autoMode未設定の警告文言が含まれる"

echo "=== scenario 2: 設定ファイルは存在するがautoModeキー自体が無い → 警告する ==="
echo '{"permissions": {"allow": []}}' > "$TMPDIR_TEST/settings-no-automode.json"
OUT="$(CLAUDE_USER_SETTINGS_PATH="$TMPDIR_TEST/settings-no-automode.json" bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"

echo "=== scenario 3: autoModeはあるがhard_denyが空配列 → 警告する ==="
echo '{"autoMode": {"environment": "x", "hard_deny": []}}' > "$TMPDIR_TEST/settings-empty-hard-deny.json"
OUT="$(CLAUDE_USER_SETTINGS_PATH="$TMPDIR_TEST/settings-empty-hard-deny.json" bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"

echo "=== scenario 4: autoMode.hard_denyに1件以上ルールがある → 何も出力しない ==="
echo '{"autoMode": {"environment": "x", "hard_deny": ["do not send patient data externally"]}}' > "$TMPDIR_TEST/settings-with-hard-deny.json"
OUT="$(CLAUDE_USER_SETTINGS_PATH="$TMPDIR_TEST/settings-with-hard-deny.json" bash "$SCRIPT")"
assert_empty "$OUT" "出力が空である(既に設定済みのため警告不要)"

echo "=== scenario 5: 設定ファイルが壊れたJSON → エラーにせず警告する(fail-safe) ==="
echo '{invalid json' > "$TMPDIR_TEST/settings-broken.json"
OUT="$(CLAUDE_USER_SETTINGS_PATH="$TMPDIR_TEST/settings-broken.json" bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "壊れたJSONでもクラッシュせず警告する"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
