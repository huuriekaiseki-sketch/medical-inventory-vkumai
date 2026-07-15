#!/bin/bash
# WHY: issue #348向けのPreToolUse hook(scripts/check-skip-marker-write.sh)の回帰テスト。
# 合成したtool_name/tool_inputのhook入力JSONを標準入力で渡し、
# .claude/.verify-state/*.skipへの書き込みを検知した場合にpermissionDecision: "ask"を
# 返すこと・それ以外は何も出力しないことを確認する。
# 設計: docs/superpowers/specs/2026-07-14-verification-subagent-design.md
#
# 実行: bash scripts/check-skip-marker-write.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-skip-marker-write.sh"

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

echo "=== scenario 1: Bash + touch .skip → ask ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "touch .claude/.verify-state/abc.skip"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 2: Bash + echo x > .skip(リダイレクト経由) → ask ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "echo x > .claude/.verify-state/abc.skip"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 3: Write file_path=.skip → ask ==="
input="$(jq -n '{tool_name: "Write", tool_input: {file_path: ".claude/.verify-state/abc.skip", content: "x"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 4: Bashで無関係な通常コマンド(npm test) → 何も出力しない ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "npm test"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 5: .verify-state配下だが.skip拡張子ではないファイル(cat *.json) → 何も出力しない ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "cat .claude/.verify-state/abc.json"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 6: cdで.verify-state配下に移動後、単一コマンドで相対touch → ask(issue #348回帰) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "cd .claude/.verify-state && touch abc.skip"}, cwd: "/repo"}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 7: 事前にcd済みのcwdから相対touchのみを実行 → ask(issue #348回帰) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "touch abc.skip"}, cwd: "/repo/.claude/.verify-state"}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 8: python3経由でフルパス書き込み → ask ==="
python3_cmd='python3 -c "open('"'"'.claude/.verify-state/abc.skip'"'"',\"w\").close()"'
input="$(jq -n --arg cmd "$python3_cmd" '{tool_name: "Bash", tool_input: {command: $cmd}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 9: node経由でフルパス書き込み → ask ==="
node_cmd='node -e "require('"'"'fs'"'"').writeFileSync('"'"'.claude/.verify-state/abc.skip'"'"',\"\")"'
input="$(jq -n --arg cmd "$node_cmd" '{tool_name: "Bash", tool_input: {command: $cmd}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 10: Editツールでfile_pathが.skip → ask ==="
input="$(jq -n '{tool_name: "Edit", tool_input: {file_path: ".claude/.verify-state/abc.skip", old_string: "x", new_string: "y"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 11: MultiEditツールでfile_pathが.skip → ask(マッチャー抜け漏れ修正) ==="
input="$(jq -n '{tool_name: "MultiEdit", tool_input: {file_path: ".claude/.verify-state/abc.skip", edits: [{old_string: "x", new_string: "y"}]}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 12: cdを伴わないディレクトリ言及(ls)+無関係な.skipファイルへの操作 → 何も出力しない(誤検知修正の回帰) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "ls .claude/.verify-state && rm old-backup.skip"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である(cdを伴わないディレクトリ参照は誤検知としない)"

echo "=== scenario 13: .claude/settings.jsonのmatcherと本スクリプトのcase文のツール一覧が一致する(matcher/case文の二重管理による抜け漏れの再発防止) ==="
SETTINGS_FILE="$SCRIPT_DIR/../.claude/settings.json"
MATCHER_TOOLS="$(jq -r '.hooks.PreToolUse[] | select(.hooks[].command | endswith("check-skip-marker-write.sh")) | .matcher' "$SETTINGS_FILE" | tr '|' '\n' | sort)"
CASE_TOOLS="$(grep -oE '^  [A-Za-z]+(\|[A-Za-z]+)*\)' "$SCRIPT" | grep -v '^  \*)' | tr -d ' )' | tr '|' '\n' | sort -u)"
assert_eq "$CASE_TOOLS" "$MATCHER_TOOLS" "settings.jsonのmatcherとcase文のツール一覧(Bash/Write/Edit/MultiEdit)が一致する(片方だけ変更されている場合はここで失敗する)"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
