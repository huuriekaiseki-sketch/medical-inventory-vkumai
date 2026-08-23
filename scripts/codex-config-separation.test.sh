#!/bin/bash
# WHY: Claude Code / Codex 共存設計（docs/agents/claude-codex-coexistence-template.md）の
# 「設定ファイルの完全分離」「共有スクリプトのツール非依存」「Codex出力契約の違い」を
# 機械的に固定する回帰テスト。riff-gear/cardiosearchで実測した事故パターン
# （$CLAUDE_PROJECT_DIR依存でCodex hookが無言死・ask未対応・transcript形式依存）の再発防止。
#
# 実行: bash scripts/codex-config-separation.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_JSON="$REPO_ROOT/.codex/hooks.json"
CLAUDE_SETTINGS="$REPO_ROOT/.claude/settings.json"

fail=0
assert_ok() {
  local label="$1"
  echo "  OK: $label"
}
assert_fail() {
  local label="$1" detail="${2:-}"
  echo "  NG: $label"
  [ -n "$detail" ] && echo "      $detail"
  fail=1
}

echo "=== scenario 1: .codex/hooks.json が存在し有効なJSONである ==="
if [ -f "$HOOKS_JSON" ]; then
  assert_ok "存在する"
  if jq empty "$HOOKS_JSON" 2>/dev/null; then
    assert_ok "有効なJSON"
  else
    assert_fail "有効なJSON"
  fi
else
  assert_fail ".codex/hooks.json が存在しない"
fi

echo "=== scenario 2: .codex/配下に \$CLAUDE_PROJECT_DIR 等のClaude専用環境変数が無い（原則1・2） ==="
if grep -rl 'CLAUDE_PROJECT_DIR' "$REPO_ROOT/.codex" 2>/dev/null; then
  assert_fail ".codex/配下にCLAUDE_PROJECT_DIR依存がある"
else
  assert_ok "CLAUDE_PROJECT_DIR依存なし"
fi

echo "=== scenario 3: .codex/hooks.json のcommandはgitベースのパス解決を使う（原則2） ==="
if [ -f "$HOOKS_JSON" ]; then
  NON_GIT_COMMANDS="$(jq -r '[.hooks[][]?.hooks[]?.command // empty] | map(select(test("git rev-parse --show-toplevel") | not)) | .[]' "$HOOKS_JSON" 2>/dev/null)"
  if [ -z "$NON_GIT_COMMANDS" ]; then
    assert_ok "全commandが git rev-parse --show-toplevel でパス解決している"
  else
    assert_fail "gitベース解決でないcommandがある" "$NON_GIT_COMMANDS"
  fi
else
  assert_fail "hooks.jsonが無いため検証不能"
fi

echo "=== scenario 4: 共有deny系ガード(check-direct-ddl-execution.sh)がCodex側にも登録されている（共有面の固定） ==="
if [ -f "$HOOKS_JSON" ] && jq -e '.hooks.PreToolUse[]? | select(.hooks[]?.command | test("check-direct-ddl-execution\\.sh"))' "$HOOKS_JSON" >/dev/null 2>&1; then
  assert_ok "PreToolUseにcheck-direct-ddl-execution.shが登録されている"
  MATCHER="$(jq -r '.hooks.PreToolUse[] | select(.hooks[].command | test("check-direct-ddl-execution\\.sh")) | .matcher' "$HOOKS_JSON")"
  if printf '%s' "$MATCHER" | grep -q 'Bash'; then
    assert_ok "matcherにBashが含まれる"
  else
    assert_fail "matcherにBashが含まれない" "matcher=$MATCHER"
  fi
  if printf '%s' "$MATCHER" | grep -q 'execute_sql'; then
    assert_ok "matcherにexecute_sqlが含まれる"
  else
    assert_fail "matcherにexecute_sqlが含まれない" "matcher=$MATCHER"
  fi
else
  assert_fail "check-direct-ddl-execution.shがCodex PreToolUseに未登録"
fi

echo "=== scenario 5: ask型ガード(check-skip-marker-write.sh)を直接登録せず、deny変換ラッパー経由で登録する（原則3: Codexはask未対応） ==="
if [ -f "$HOOKS_JSON" ]; then
  if jq -e '.hooks.PreToolUse[]? | select(.hooks[]?.command | test("check-skip-marker-write\\.sh"))' "$HOOKS_JSON" >/dev/null 2>&1; then
    assert_fail "ask型のcheck-skip-marker-write.shが直接登録されている（Codexはask未対応のため素通りする）"
  else
    assert_ok "ask型ガードの直接登録なし"
  fi
  if jq -e '.hooks.PreToolUse[]? | select(.hooks[]?.command | test("codex-skip-marker-deny\\.sh"))' "$HOOKS_JSON" >/dev/null 2>&1; then
    assert_ok "deny変換ラッパー(codex-skip-marker-deny.sh)が登録されている"
  else
    assert_fail "deny変換ラッパーが未登録"
  fi
else
  assert_fail "hooks.jsonが無いため検証不能"
fi

echo "=== scenario 6: Claude transcript形式依存のスクリプトをCodex側に登録しない（原則7） ==="
if [ -f "$HOOKS_JSON" ]; then
  TRANSCRIPT_DEPENDENT="verify-claims\.sh|ai-check-suggest\.sh|log-subagent-hook-skeleton\.sh|check-handoff-format\.sh|check-aidd-stats-recorded\.sh|check-aidd-phase-stats-recorded\.sh|check-find-av-precision-recorded\.sh|check-gap-check-state\.sh"
  FOUND="$(jq -r '[.hooks[][]?.hooks[]?.command // empty] | .[]' "$HOOKS_JSON" | grep -E "$TRANSCRIPT_DEPENDENT" || true)"
  if [ -z "$FOUND" ]; then
    assert_ok "transcript依存スクリプトの登録なし"
  else
    assert_fail "transcript依存スクリプトが登録されている" "$FOUND"
  fi
else
  assert_fail "hooks.jsonが無いため検証不能"
fi

echo "=== scenario 7: .claude/settings.json が .codex/ を参照しない（原則1の逆方向） ==="
if grep -q '\.codex/' "$CLAUDE_SETTINGS"; then
  assert_fail ".claude/settings.jsonが.codex/を参照している"
else
  assert_ok "逆方向の参照なし"
fi

echo "=== scenario 8: 共有ガード本体がツール非依存（scripts/配下の共有ロジックにCLAUDE_PROJECT_DIR依存が無い、原則2） ==="
SHARED_GUARDS="check-direct-ddl-execution.sh check-skip-marker-write.sh check-branch-pr-status.sh check-local-main-freshness.sh"
BAD=""
for g in $SHARED_GUARDS; do
  if grep -q 'CLAUDE_PROJECT_DIR' "$SCRIPT_DIR/$g" 2>/dev/null; then
    BAD="$BAD $g"
  fi
done
if [ -z "$BAD" ]; then
  assert_ok "共有ガード4本にCLAUDE_PROJECT_DIR依存なし"
else
  assert_fail "共有ガードにCLAUDE_PROJECT_DIR依存がある" "$BAD"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
