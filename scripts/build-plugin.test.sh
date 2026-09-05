#!/bin/bash
# WHY: scripts/build-plugin.sh（プラグイン v1 の生成、issue #420 セット C）の回帰テスト。
#   1. 実態のリポジトリから生成でき、2 回生成しても一致する（決定性）
#   2. 生成物の workflow に名前空間の無い agentType / workflow( が残らない
#   3. hooks.json が settings.json の登録から作られ、${CLAUDE_PLUGIN_ROOT} を指す
#   4. コミット済みの dist/plugins/ が最新（--check）
#   5. RED: 共通側に禁止語を仕込むと生成が失敗する / 同梱されていない参照を検知する /
#      層の表に無い hook を検知する（fixture のミニリポジトリで自己検証）
#
# 実行: bash scripts/build-plugin.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD="$SCRIPT_DIR/lib/build-plugin.mjs"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== scenario 1: 実態から生成できる・2 回の生成が一致する（決定性） ==="
node "$BUILD" --out "$WORK/a" >/dev/null
node "$BUILD" --out "$WORK/b" >/dev/null
if diff -r "$WORK/a" "$WORK/b" >/dev/null; then ok "2 回の生成が一致"; else ng "生成が決定的でない" "$(diff -r "$WORK/a" "$WORK/b" | head -5)"; fi
[ -f "$WORK/a/aidd-core/.claude-plugin/plugin.json" ] && ok "aidd-core の manifest がある" || ng "aidd-core の manifest が無い"
[ -f "$WORK/a/aidd-vkumai/.claude-plugin/plugin.json" ] && ok "aidd-vkumai の manifest がある" || ng "aidd-vkumai の manifest が無い"
if jq -e '.dependencies[0].name == "aidd-core"' "$WORK/a/aidd-vkumai/.claude-plugin/plugin.json" >/dev/null; then ok "aidd-vkumai は aidd-core に依存"; else ng "依存が書かれていない"; fi

echo "=== scenario 2: 生成物の workflow は名前空間付きで、LOCAL 設定は空 ==="
BARE="$(grep -h -o -E "agentType: '[^':]+'" "$WORK"/a/*/workflows/*.js || true)"
[ -z "$BARE" ] && ok "裸の agentType が無い" || ng "裸の agentType が残る" "$BARE"
if grep -q "agentType: 'aidd-vkumai:sweep-ui'" "$WORK/a/aidd-vkumai/workflows/aidd-phase1.js"; then ok "sweep-ui が aidd-vkumai:sweep-ui になる"; else ng "agentType の書き換え無し"; fi
if grep -q "workflow('aidd-vkumai:aidd-phase1'" "$WORK/a/aidd-vkumai/workflows/aidd-phase1-router.js"; then ok "workflow() も修飾される"; else ng "workflow() の書き換え無し"; fi
if grep -q "const LOCAL_RISK_CONFIG = {}" "$WORK/a/aidd-vkumai/workflows/aidd-phase1-router.js"; then ok "LOCAL_RISK_CONFIG が空になる"; else ng "LOCAL 設定が残っている"; fi
if grep -q "facility" "$WORK/a/aidd-vkumai/workflows/aidd-phase1-router.js"; then ok "アダプター側の説明文の固有語は残してよい（禁止語検査は共通側のみ）"; fi

echo "=== scenario 3: hooks.json は settings.json から作られ、\${CLAUDE_PLUGIN_ROOT} を指す ==="
CORE_HOOKS="$WORK/a/aidd-core/hooks/hooks.json"
jq -e '.hooks.SessionStart' "$CORE_HOOKS" >/dev/null && ok "SessionStart がある" || ng "SessionStart が無い"
if jq -r '.. | .command? // empty' "$CORE_HOOKS" | grep -q 'CLAUDE_PROJECT_DIR'; then ng "CLAUDE_PROJECT_DIR が残っている"; else ok "パスは CLAUDE_PLUGIN_ROOT に置き換わる"; fi
if jq -r '.. | .command? // empty' "$CORE_HOOKS" | grep -q 'check-branch-tool-ownership.sh claude'; then ok "引数付き hook も引数を保つ"; else ng "引数が落ちた"; fi
if jq -r '.. | .command? // empty' "$CORE_HOOKS" | grep -q 'check-direct-ddl-execution'; then ng "vkumai 専用 hook が core に混入"; else ok "vkumai 専用 hook は core に入らない"; fi
if jq -r '.. | .command? // empty' "$WORK/a/aidd-vkumai/hooks/hooks.json" | grep -q 'check-direct-ddl-execution'; then ok "vkumai 専用 hook はアダプター側にある"; else ng "アダプター側に無い"; fi
for f in $(jq -r '.. | .command? // empty' "$CORE_HOOKS" | sed -E 's#^"\$\{CLAUDE_PLUGIN_ROOT\}"/##; s# .*$##'); do
  [ -f "$WORK/a/aidd-core/$f" ] || ng "hooks.json が指すスクリプトが同梱されていない: $f"
done
ok "hooks.json が指すスクリプトはすべて同梱されている（欠落があれば上に NG）"
[ -x "$WORK/a/aidd-core/bin/log-agent-progress.sh" ] && ok "bin/ に進捗記録スクリプトがあり実行可能" || ng "bin/ が無い"
if grep -q "scripts/log-agent-progress.sh" "$WORK/a/aidd-core/agents/reviewer.md"; then ng "agent 本文の scripts/ 参照が残る"; else ok "agent 本文の scripts/<bin> は裸の名前に書き換わる"; fi

echo "=== scenario 4: コミット済みの dist/plugins/ が最新（--check） ==="
if node "$BUILD" --check >/dev/null 2>"$WORK/check.err"; then ok "dist/plugins/ は最新"; else ng "dist/plugins/ が古い（bash scripts/build-plugin.sh で更新）" "$(head -5 "$WORK/check.err")"; fi

echo "=== scenario 4b: 7 項目のファイル・スキーマ・ひな形が生成物にある（SPEC Part 1 の 3.） ==="
for p in aidd-core aidd-vkumai; do
  for f in COMPATIBILITY.md CHANGELOG.md KNOWN-LIMITS.md MIGRATION.md BREAKING.md; do
    [ -f "$WORK/a/$p/$f" ] || ng "$p に $f が無い"
  done
  [ -n "$(ls "$WORK/a/$p/evidence" 2>/dev/null)" ] || ng "$p に evidence/ が無い"
done
ok "両プラグインに 5 文書と evidence/ がある（欠落があれば上に NG）"
[ -f "$WORK/a/aidd-core/schema/aidd-config.schema.json" ] && ok "設定スキーマが aidd-core/schema/ にある" || ng "スキーマが無い"
[ -f "$WORK/a/aidd-core/templates/consumer/aidd.config.json" ] && ok "導入先ひな形が aidd-core/templates/ にある" || ng "ひな形が無い"
# COMPATIBILITY.md の版は docs/agents/upstream-docs-review.md「最後に確認した版」（正本）と一致する
REVIEWED="$(grep -o -E 'Claude Code \| [0-9]+\.[0-9]+\.[0-9]+' "$REPO_ROOT/docs/agents/upstream-docs-review.md" | head -n1 | grep -o -E '[0-9]+\.[0-9]+\.[0-9]+' || true)"
if [ -n "$REVIEWED" ] && grep -q "$REVIEWED" "$WORK/a/aidd-core/COMPATIBILITY.md"; then ok "COMPATIBILITY.md が docs 確認版 $REVIEWED を含む"; else ng "COMPATIBILITY.md の版が upstream-docs-review と食い違う（reviewed=$REVIEWED）"; fi

echo "=== scenario 5: RED 方向（fixture のミニリポジトリ） ==="
FX="$WORK/fixture"
mkdir -p "$FX/.claude/agents" "$FX/.claude/workflows" "$FX/scripts/lib"
cat > "$FX/.claude/settings.json" <<'EOF'
{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"$CLAUDE_PROJECT_DIR/scripts/hook-a.sh","timeout":5}]}]}}
EOF
printf '#!/usr/bin/env bash\nsource "$SCRIPT_DIR/lib/helper.sh"\necho ok\n' > "$FX/scripts/hook-a.sh"
printf 'helper() { :; }\n' > "$FX/scripts/lib/helper.sh"
printf -- '---\nname: agent-a\n---\n本文\n' > "$FX/.claude/agents/agent-a.md"
printf "export const meta = { name: 'flow-a' }\nawait agent('x', { agentType: 'agent-a' })\n" > "$FX/.claude/workflows/flow-a.js"
cat > "$FX/layout.json" <<'EOF'
{
  "plugins": {"core": {"version": "0.0.1", "description": "d", "dependencies": [], "forbiddenWords": true}},
  "forbiddenWords": ["forbiddenword"],
  "agents": {"agent-a": "core"},
  "skills": {},
  "workflows": {"flow-a": "core"},
  "hookScripts": {"hook-a.sh": "core"},
  "supportScripts": {"lib/helper.sh": "core"},
  "bin": {},
  "allowUnresolvedReferences": {}
}
EOF
if node "$BUILD" --source "$FX" --layout "$FX/layout.json" --out "$WORK/fx-ok" >/dev/null 2>&1; then ok "正しい fixture は生成できる"; else ng "正しい fixture で失敗"; fi
grep -q "agentType: 'core:agent-a'" "$WORK/fx-ok/core/workflows/flow-a.js" && ok "fixture でも名前空間が付く" || ng "fixture の名前空間"

printf -- '---\nname: agent-a\n---\n本文 forbiddenword\n' > "$FX/.claude/agents/agent-a.md"
if node "$BUILD" --source "$FX" --layout "$FX/layout.json" --out "$WORK/fx-red1" >/dev/null 2>"$WORK/red1.err"; then ng "禁止語を検知できない"; else grep -q '禁止語' "$WORK/red1.err" && ok "禁止語で失敗する" || ng "失敗理由が禁止語でない" "$(cat "$WORK/red1.err")"; fi
[ ! -d "$WORK/fx-red1" ] && ok "失敗時は出力を書かない" || ng "失敗時に出力が書かれた"
printf -- '---\nname: agent-a\n---\n本文\n' > "$FX/.claude/agents/agent-a.md"

printf '#!/usr/bin/env bash\nsource "$SCRIPT_DIR/lib/missing.sh"\n' > "$FX/scripts/hook-a.sh"
if node "$BUILD" --source "$FX" --layout "$FX/layout.json" --out "$WORK/fx-red2" >/dev/null 2>"$WORK/red2.err"; then ng "同梱漏れを検知できない"; else grep -q '同梱されていない' "$WORK/red2.err" && ok "同梱されていない参照で失敗する" || ng "失敗理由が同梱漏れでない" "$(cat "$WORK/red2.err")"; fi
printf '#!/usr/bin/env bash\nsource "$SCRIPT_DIR/lib/helper.sh"\necho ok\n' > "$FX/scripts/hook-a.sh"

cat > "$FX/.claude/settings.json" <<'EOF'
{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"$CLAUDE_PROJECT_DIR/scripts/hook-a.sh","timeout":5},{"type":"command","command":"$CLAUDE_PROJECT_DIR/scripts/hook-b.sh","timeout":5}]}]}}
EOF
if node "$BUILD" --source "$FX" --layout "$FX/layout.json" --out "$WORK/fx-red3" >/dev/null 2>"$WORK/red3.err"; then ng "層の表に無い hook を検知できない"; else grep -q 'hookScripts に無い' "$WORK/red3.err" && ok "層の表に無い hook で失敗する" || ng "失敗理由が違う" "$(cat "$WORK/red3.err")"; fi

if [ "$fail" -ne 0 ]; then echo "FAILED"; exit 1; fi
echo "ALL PASSED"
