#!/bin/bash
# WHY: scripts/check-readonly-bash.sh（読み取り専用ロールの subagent frontmatter hooks.PreToolUse、
#      issue #713）の回帰テスト。許可リストのコマンドは沈黙（allow）、書き込み手段は deny JSON を
#      返すことを、実運用で読み取り専用ロールが打つコマンド（rg 一覧化・進捗記録スクリプト・
#      npm test）と代表的な書き込み手段（sed -i / リダイレクト / rm / git checkout / node -e）で確認する。
#
# 実行: bash scripts/check-readonly-bash.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-readonly-bash.sh"

fail=0
# $1=command $2=agent_type（既定 sweep-ui。空文字ならフィールド自体を省略）
run() {
  local agent="${2-sweep-ui}"
  if [ -n "$agent" ]; then
    printf '{"tool_name":"Bash","agent_id":"a1","agent_type":%s,"tool_input":{"command":%s}}' "$(jq -Rn --arg a "$agent" '$a')" "$(jq -Rn --arg c "$1" '$c')" | bash "$SCRIPT"
  else
    printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(jq -Rn --arg c "$1" '$c')" | bash "$SCRIPT"
  fi
}
assert_allow() {
  local out; out="$(run "$1")"
  if [ -z "$out" ]; then echo "  OK: allow: $1"; else echo "  NG: allow 期待だが deny: $1"; echo "      $out"; fail=1; fi
}
assert_deny() {
  local out; out="$(run "$1")"
  if printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1; then
    echo "  OK: deny: $1"
  else
    echo "  NG: deny 期待だが allow: $1"; fail=1
  fi
}

echo "=== scenario 1: 読み取り専用ロールが実運用で打つコマンドは allow ==="
assert_allow 'rg --files src/app src/components'
assert_allow 'cat src/app/page.tsx'
assert_allow 'grep -rn "target=\"_blank\"" src/components'
assert_allow 'find src -name "*.tsx"'
assert_allow 'scripts/log-agent-progress.sh --agent sweep-ui --feature x --status running --note "開始"'
assert_allow 'bash scripts/log-loop-observability.sh --loop developer --agent reviewer --result pass'
assert_allow 'bash scripts/show-agent-status.sh'
assert_allow 'git status --porcelain'
assert_allow 'git diff origin/main -- src/'
assert_allow 'git log --oneline -5'
assert_allow 'npm test'
assert_allow 'npm run lint'
assert_allow 'npx tsc --noEmit'
assert_allow 'sed -n "10,20p" src/app/page.tsx'
assert_allow 'cat file.txt 2>/dev/null'
assert_allow 'npm test 2>&1'
assert_allow 'ls src >/dev/null'
assert_allow 'wc -l $(find src -name "*.ts")'
assert_allow 'CLAUDE_PROJECT_DIR=/tmp/x bash scripts/check-claude-md-size.sh'
assert_allow 'cd src/lib && rg "supabase" .'
assert_allow 'jq -r ".name" package.json'
assert_allow '/usr/bin/grep -c foo file'

echo "=== scenario 2: 書き込み手段は deny ==="
assert_deny 'sed -i "" "s/a/b/" src/app/page.tsx'
assert_deny 'sed -i.bak s/a/b/ file'
assert_deny 'echo hello > /tmp/x.txt'
assert_deny 'cat a >> b'
assert_deny 'rm -rf /tmp/x'
assert_deny 'mkdir -p /tmp/x'
assert_deny 'touch newfile'
assert_deny 'cp a b'
assert_deny 'mv a b'
assert_deny 'git checkout -- src/'
assert_deny 'git commit -m x'
assert_deny 'git stash'
assert_deny 'git push'
assert_deny 'npm install lodash'
assert_deny 'npx playwright test'
assert_deny 'node -e "require(\"fs\").writeFileSync(\"x\",\"y\")"'
assert_deny 'tee out.txt'
assert_deny 'chmod +x file'
assert_deny 'supabase db push'
assert_deny 'psql -c "drop table x"'
assert_deny 'bash -c "rm -rf x"'
assert_deny 'bash /tmp/evil.sh'
assert_deny 'cat a | tee b'
assert_deny 'rg foo; rm bar'
assert_deny 'ls && mkdir x'
assert_deny 'echo $(rm x)'
assert_deny 'FOO=1 rm x'
assert_deny 'curl https://example.com -o file'

echo "=== scenario 2b: 読み取り専用ロール以外・メインセッションでは何もしない（agent_type 判定） ==="
for agent in implementer integrator contract-writer; do
  OUT="$(run 'rm -rf /tmp/x' "$agent")"
  if [ -z "$OUT" ]; then echo "  OK: $agent は対象外（rm を許可）"; else echo "  NG: $agent で deny された"; fail=1; fi
done
OUT="$(run 'rm -rf /tmp/x' "")"
if [ -z "$OUT" ]; then echo "  OK: agent_type 無し（メインセッション）は対象外"; else echo "  NG: メインセッションで deny された"; fail=1; fi
for agent in sweep-data sweep-db sweep-types reviewer completeness-critic adversarial-verify judge-panel; do
  assert_deny_for() { local out; out="$(run "$1" "$2")"; if printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1; then echo "  OK: $2 で deny: $1"; else echo "  NG: $2 で allow: $1"; fail=1; fi; }
  assert_deny_for 'rm -rf /tmp/x' "$agent"
done
OUT="$(READONLY_AGENT_TYPES="custom-role" run 'rm -rf /tmp/x' "custom-role")"
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1; then echo "  OK: READONLY_AGENT_TYPES で対象ロールを差し替えられる"; else echo "  NG: 環境変数での差し替えが効かない"; fail=1; fi

echo "=== scenario 2c: 対象ロールは aidd.config.json の readonlyAgentTypes から読む（issue #420 v1 セット B2） ==="
CFG_DIR="$(mktemp -d)"
printf '{"readonlyAgentTypes":["custom-role"]}\n' > "$CFG_DIR/aidd.config.json"
OUT="$(printf '{"tool_name":"Bash","agent_id":"a1","agent_type":"custom-role","tool_input":{"command":"rm -rf /tmp/x"}}' | AIDD_CONFIG_FILE="$CFG_DIR/aidd.config.json" bash "$SCRIPT")"
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1; then echo "  OK: 設定のロールが deny 対象になる"; else echo "  NG: 設定のロールが効かない"; fail=1; fi
OUT="$(printf '{"tool_name":"Bash","agent_id":"a1","agent_type":"sweep-ui","tool_input":{"command":"rm -rf /tmp/x"}}' | AIDD_CONFIG_FILE="$CFG_DIR/aidd.config.json" bash "$SCRIPT")"
if [ -z "$OUT" ]; then echo "  OK: 設定に無いロール（sweep-ui）は設定があるとき対象外"; else echo "  NG: 設定があるのに既定ロールが残っている"; fail=1; fi
OUT="$(printf '{"tool_name":"Bash","agent_id":"a1","agent_type":"sweep-ui","tool_input":{"command":"rm -rf /tmp/x"}}' | AIDD_CONFIG_FILE="$CFG_DIR/none.json" bash "$SCRIPT")"
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1; then echo "  OK: 設定ファイルが無ければ既定ロールで deny"; else echo "  NG: 設定無しで既定ロールが効かない"; fail=1; fi
OUT="$(printf '{"tool_name":"Bash","agent_id":"a1","agent_type":"env-role","tool_input":{"command":"rm -rf /tmp/x"}}' | AIDD_CONFIG_FILE="$CFG_DIR/aidd.config.json" READONLY_AGENT_TYPES="env-role" bash "$SCRIPT")"
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1; then echo "  OK: 環境変数は設定ファイルより優先"; else echo "  NG: 環境変数の優先が崩れた"; fail=1; fi
rm -rf "$CFG_DIR"

echo "=== scenario 3: Bash 以外のツール・空コマンドは何もしない ==="
OUT="$(printf '{"tool_name":"Read","tool_input":{"file_path":"x"}}' | bash "$SCRIPT")"
if [ -z "$OUT" ]; then echo "  OK: Read は対象外"; else echo "  NG: Read で出力あり"; fail=1; fi
OUT="$(printf '{"tool_name":"Bash","tool_input":{}}' | bash "$SCRIPT")"
if [ -z "$OUT" ]; then echo "  OK: 空コマンドは沈黙"; else echo "  NG: 空コマンドで出力あり"; fail=1; fi

echo "=== scenario 4: deny 出力は PreToolUse の契約どおり ==="
OUT="$(run 'rm -rf x')"
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.hookEventName == "PreToolUse" and (.hookSpecificOutput.permissionDecisionReason | length > 0)' >/dev/null; then
  echo "  OK: hookEventName / permissionDecisionReason がある"
else
  echo "  NG: 出力契約違反: $OUT"; fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
