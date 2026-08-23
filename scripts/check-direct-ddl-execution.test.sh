#!/bin/bash
# WHY: issue #444・#485向けのPreToolUse hook(scripts/check-direct-ddl-execution.sh)の回帰テスト。
# supabase db execute/psqlの直接実行、およびMCP経由のexecute_sql系ツール呼び出しを
# permissionDecision: "deny"で拒否すること・db reset等の正規手段は対象外であることを確認する。
# supabase db pushのみ例外的に対象内（--local明示時のみ許可、フラグ無指定・--linked等は
# デフォルトでリモート本番を対象とするためdeny。issue #485）。
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

echo "=== scenario 4: supabase db push（フラグ無指定） → deny（issue #485: デフォルトでリモート本番が対象のため） ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "supabase db push"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される"

echo "=== scenario 4b: supabase db push --local → 対象外(明示的にローカル指定・正規のmigration適用手段) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "supabase db push --local"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である(--local明示時はdeny対象外)"

echo "=== scenario 4c: supabase db push --linked → deny（明示的にリモート指定） ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "supabase db push --linked"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される"

echo "=== scenario 4d: npx supabase db push（フラグ無指定） → deny ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "npx supabase db push"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される"

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

echo "=== scenario 11: パイプ直結のpsql(cat schema.sql|psql mydb) → deny(issue #633: 境界文字クラスにパイプ追加) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "cat schema.sql|psql mydb"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される"

echo "=== scenario 12: コマンド置換経由のpsql(\$(psql -c ...)) → deny(issue #633) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "$(psql -c \"drop table x\")"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される"

echo "=== scenario 13: フルパス呼び出し(/usr/bin/psql) → deny(issue #633) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "/usr/bin/psql -c \"drop table x\""}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される"

echo "=== scenario 14: which psql → 対象外(読み取り専用の前置コマンド、issue #633の誤denyでない側の確認) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "which psql"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である(whichは実行を伴わないため誤denyしない)"

echo "=== scenario 15: git grep psql → 対象外(読み取り専用の前置コマンド、issue #633) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "git grep psql"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である(git grepは実行を伴わないため誤denyしない)"

echo "=== scenario 16: 無関係な位置に--localがあるだけのdb push(echo see --local docs; supabase db push) → deny(issue #634) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "echo see --local docs; supabase db push"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される"

echo "=== scenario 17: --local指定の直後に素のdb pushが続く(supabase db push --local && supabase db push) → deny(issue #634) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "supabase db push --local && supabase db push"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される"

echo "=== scenario 19: 絶対パス呼び出しのsupabase(/opt/homebrew/bin/supabase db execute) → deny(パス前置の迂回経路) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "/opt/homebrew/bin/supabase db execute --sql \"drop table x\""}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される"

echo "=== scenario 20: 相対パス呼び出しのsupabase(./node_modules/.bin/supabase db push 素) → deny(パス前置の迂回経路) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "./node_modules/.bin/supabase db push"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "deny"' "permissionDecision: denyが出力される"

echo "=== scenario 21: 相対パス呼び出しのsupabase db push --local → 対象外(パス前置でも--local明示は正規手段) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "node_modules/.bin/supabase db push --local"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である(--local明示時はdeny対象外)"

echo "=== scenario 10: .claude/settings.jsonのmatcherが両パターンをカバーしている(Bash・mcp__.*execute_sql) ==="
SETTINGS_FILE="$SCRIPT_DIR/../.claude/settings.json"
MATCHER="$(jq -r '.hooks.PreToolUse[] | select(.hooks[].command | endswith("check-direct-ddl-execution.sh")) | .matcher' "$SETTINGS_FILE")"
assert_contains "$MATCHER" "Bash" "matcherにBashが含まれる"
assert_contains "$MATCHER" "execute_sql" "matcherにexecute_sqlパターンが含まれる"

echo "=== scenario 18: jq未インストール環境 → fail-closed(exit 2でブロック、issue #636) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "psql -c \"drop table x\""}}')"
set +e
OUT="$(printf '%s' "$input" | PATH="" /bin/bash "$SCRIPT" 2>&1)"
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "2" "exit 2(fail-closed)"
assert_contains "$OUT" "jq not found" "jq未検出のエラーメッセージが出る"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
