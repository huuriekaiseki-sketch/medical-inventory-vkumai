#!/bin/bash
# WHY: scripts/check-subagent-model-force.sh（SessionStart hook、issue #743）の回帰テスト。
# CLAUDE_CODE_SUBAGENT_MODEL_FORCE が環境変数または settings の env ブロックに非空で
# あれば警告し、無ければ沈黙することを固定する。settings ファイルは
# SUBAGENT_MODEL_FORCE_SETTINGS_PATHS でテスト用に差し替える（本物の個人設定を読まない）。
#
# 実行: bash scripts/check-subagent-model-force.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-subagent-model-force.sh"

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

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
NO_SETTINGS="$WORK/none-a.json:$WORK/none-b.json"

# 実行環境（このテストを回す人のシェル）に変数が残っていても結果が変わらないよう、
# 各シナリオで env -u により明示的に消してから起動する
echo "=== scenario 1: 環境変数も settings の env も無い → 沈黙 ==="
OUT="$(env -u CLAUDE_CODE_SUBAGENT_MODEL_FORCE SUBAGENT_MODEL_FORCE_SETTINGS_PATHS="$NO_SETTINGS" bash "$SCRIPT")"
assert_empty "$OUT" "出力が空"

echo "=== scenario 2: 環境変数に非空の値 → 警告（値と検知元を含む） ==="
OUT="$(env CLAUDE_CODE_SUBAGENT_MODEL_FORCE=haiku SUBAGENT_MODEL_FORCE_SETTINGS_PATHS="$NO_SETTINGS" bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "systemMessage がある"
assert_contains "$OUT" "CLAUDE_CODE_SUBAGENT_MODEL_FORCE=haiku" "変数名と値を含む"
assert_contains "$OUT" "検知元: 環境変数" "検知元が環境変数"
assert_contains "$OUT" '"hookEventName": "SessionStart"' "SessionStart の additionalContext 形式"

echo "=== scenario 3: 環境変数が空文字 → 未設定と同じ扱いで沈黙 ==="
OUT="$(env CLAUDE_CODE_SUBAGENT_MODEL_FORCE= SUBAGENT_MODEL_FORCE_SETTINGS_PATHS="$NO_SETTINGS" bash "$SCRIPT")"
assert_empty "$OUT" "出力が空"

echo "=== scenario 4: settings の env ブロックにある → 警告（ファイルパスを検知元に含む） ==="
printf '{"env": {"CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "sonnet"}}\n' > "$WORK/settings-env.json"
OUT="$(env -u CLAUDE_CODE_SUBAGENT_MODEL_FORCE SUBAGENT_MODEL_FORCE_SETTINGS_PATHS="$WORK/none-a.json:$WORK/settings-env.json" bash "$SCRIPT")"
assert_contains "$OUT" "CLAUDE_CODE_SUBAGENT_MODEL_FORCE=sonnet" "settings 側の値を含む"
assert_contains "$OUT" "$WORK/settings-env.json の env" "検知元がファイルパス"

echo "=== scenario 5: settings に env ブロックはあるが当該キーが無い → 沈黙 ==="
printf '{"env": {"OTHER": "x"}, "permissions": {}}\n' > "$WORK/settings-other.json"
OUT="$(env -u CLAUDE_CODE_SUBAGENT_MODEL_FORCE SUBAGENT_MODEL_FORCE_SETTINGS_PATHS="$WORK/settings-other.json" bash "$SCRIPT")"
assert_empty "$OUT" "出力が空"

echo "=== scenario 6: settings が壊れた JSON → クラッシュせず沈黙（fail-open） ==="
printf '{broken\n' > "$WORK/settings-broken.json"
OUT="$(env -u CLAUDE_CODE_SUBAGENT_MODEL_FORCE SUBAGENT_MODEL_FORCE_SETTINGS_PATHS="$WORK/settings-broken.json" bash "$SCRIPT")"
assert_empty "$OUT" "出力が空"

echo "=== scenario 7: 環境変数と settings の両方にある → 環境変数を優先して 1 回だけ警告 ==="
OUT="$(env CLAUDE_CODE_SUBAGENT_MODEL_FORCE=opus SUBAGENT_MODEL_FORCE_SETTINGS_PATHS="$WORK/settings-env.json" bash "$SCRIPT")"
assert_contains "$OUT" "CLAUDE_CODE_SUBAGENT_MODEL_FORCE=opus" "環境変数側の値"
assert_contains "$OUT" "検知元: 環境変数" "検知元が環境変数"
COUNT="$(printf '%s' "$OUT" | grep -c 'systemMessage' || true)"
if [ "$COUNT" -eq 1 ]; then
  echo "  OK: 警告は 1 件"
else
  echo "  NG: 警告件数=$COUNT"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
