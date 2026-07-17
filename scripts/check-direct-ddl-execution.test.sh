#!/bin/bash
# WHY: issue #444向けのPreToolUse hook(scripts/check-direct-ddl-execution.sh)の回帰テスト。
# supabase db execute/psqlの直接実行、およびMCP経由のexecute_sql系ツール呼び出しを
# permissionDecision: "deny"で拒否すること・db push等の正規手段は対象外であることを確認する。
#
# 実行: bash scripts/check-direct-ddl-execution.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-direct-ddl-execution.sh"

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

echo "=== scenario 1: supabase db execute → deny ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "supabase db execute --sql \"select 1\""}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される"

echo "=== scenario 2: npx supabase db execute → deny ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "npx supabase db execute --sql \"alter table x add column y int\""}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される"

echo "=== scenario 3: psql直接実行 → deny ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "psql postgres://localhost/db -c \"drop table x\""}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される"

echo "=== scenario 4: supabase db push → 対象外(正規のmigration適用手段) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "supabase db push"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である(db pushはdeny対象外)"

echo "=== scenario 5: supabase db reset → 対象外 ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "supabase db reset"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である(db resetはdeny対象外)"

echo "=== scenario 6: 無関係な通常コマンド(npm test) → 何も出力しない ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "npm test"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 7: MCP経由のexecute_sqlツール(mcp__supabase__execute_sql) → deny ==="
input="$(jq -n '{tool_name: "mcp__supabase__execute_sql", tool_input: {sql: "drop table x"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される(MCPツール経由でも素通りしない)"

echo "=== scenario 8: MCPでもexecute_sql以外のツール(mcp__supabase__apply_migration)は対象外 ==="
input="$(jq -n '{tool_name: "mcp__supabase__apply_migration", tool_input: {name: "x", query: "create table x()"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である(apply_migrationは正規のmigration適用手段)"

echo "=== scenario 9: サーバー名が異なるMCPツール(mcp__postgres__execute_sql)でも検知する(サーバー名非依存の設計確認) ==="
input="$(jq -n '{tool_name: "mcp__postgres__execute_sql", tool_input: {sql: "drop table x"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される"

echo "=== scenario 10: .claude/settings.jsonのmatcherが両パターンをカバーしている(Bash・mcp__.*execute_sql) ==="
SETTINGS_FILE="$SCRIPT_DIR/../.claude/settings.json"
MATCHER="$(jq -r '.hooks.PreToolUse[] | select(.hooks[].command | endswith("check-direct-ddl-execution.sh")) | .matcher' "$SETTINGS_FILE")"
assert_contains "$MATCHER" "Bash" "matcherにBashが含まれる"
assert_contains "$MATCHER" "execute_sql" "matcherにexecute_sqlパターンが含まれる"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
