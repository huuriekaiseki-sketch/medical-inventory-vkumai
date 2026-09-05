#!/bin/bash
# WHY: issue #712 の構造テスト。.claude/settings.json の SessionStart hook が「compact 時には
#      AIDD 実行状態の再注入だけを行い、警告系 hook は再実行しない」構成を保っていることを
#      settings.json を直接読んで検査する。
#
#      背景: SessionStart hook は matcher 無しだと startup / resume / clear / compact / fork の
#      すべてで再実行される。長時間の AIDD 自律実行中の compaction で、ブランチ鮮度・worktree
#      残骸などの警告 12 本が毎回再注入される一方、本当に必要な run-manifest / 進捗 / 復旧キューは
#      要約で薄れていた。この構成が「matcher を足し忘れた新 hook」で静かに崩れるのを止める。
#
# 不変条件:
#   1. SessionStart の全エントリが matcher を持つ（無指定 = 全 source で実行、を禁止）
#   2. source "compact" にマッチするエントリは、hooks が reinject-aidd-run-state.sh のみ
#   3. startup / resume / clear / fork の各 source には、reinject 以外のエントリが少なくとも 1 つ
#      マッチし、reinject を含むエントリはマッチしない
#   4. reinject-aidd-run-state.sh は SessionStart のどこかに必ず登録されている
#
# 実行: bash scripts/check-session-start-matchers.test.sh
# 環境変数（テスト用注入ポイント）: CLAUDE_SETTINGS_PATH（既定 .claude/settings.json）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SETTINGS="${CLAUDE_SETTINGS_PATH:-$REPO_ROOT/.claude/settings.json}"
REINJECT="reinject-aidd-run-state.sh"

command -v jq >/dev/null 2>&1 || { echo "jq が必要です"; exit 1; }

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

# 検査本体。$1=settings.json。違反を行で出し、末尾に violations=N
check() {
  local settings="$1" violations=0
  local n i matcher cmds has_reinject
  n="$(jq '.hooks.SessionStart | length' "$settings")"
  if [ "$n" -eq 0 ]; then
    echo "    empty: SessionStart エントリが 0 件"
    echo "violations=1"
    return
  fi

  local reinject_registered=0
  local -a startup_ok=(0 0 0 0)
  local sources=(startup resume clear fork)

  for ((i = 0; i < n; i++)); do
    matcher="$(jq -r ".hooks.SessionStart[$i].matcher // \"\"" "$settings")"
    cmds="$(jq -r ".hooks.SessionStart[$i].hooks[].command" "$settings")"
    has_reinject=0
    if printf '%s\n' "$cmds" | grep -qF "$REINJECT"; then has_reinject=1; reinject_registered=1; fi

    if [ -z "$matcher" ] || [ "$matcher" = "*" ]; then
      echo "    no-matcher: エントリ $i（$(printf '%s' "$cmds" | head -n1 | xargs basename) …）が全 source で実行される"
      violations=$((violations + 1))
      continue
    fi

    # compact にマッチするか
    if [[ "compact" =~ ^($matcher)$ ]]; then
      if [ "$has_reinject" -ne 1 ] || [ "$(printf '%s\n' "$cmds" | grep -c .)" -ne 1 ]; then
        echo "    compact-noise: エントリ $i（matcher=$matcher）が compact 時に reinject 以外を実行する"
        violations=$((violations + 1))
      fi
    fi

    for si in "${!sources[@]}"; do
      if [[ "${sources[$si]}" =~ ^($matcher)$ ]]; then
        if [ "$has_reinject" -eq 1 ]; then
          echo "    reinject-on-${sources[$si]}: エントリ $i（matcher=$matcher）が ${sources[$si]} で reinject を実行する"
          violations=$((violations + 1))
        else
          startup_ok[$si]=1
        fi
      fi
    done
  done

  for si in "${!sources[@]}"; do
    if [ "${startup_ok[$si]}" -ne 1 ]; then
      echo "    missing-${sources[$si]}: ${sources[$si]} で実行される警告系エントリが無い"
      violations=$((violations + 1))
    fi
  done
  if [ "$reinject_registered" -ne 1 ]; then
    echo "    missing-reinject: $REINJECT が SessionStart に登録されていない"
    violations=$((violations + 1))
  fi
  echo "violations=$violations"
}

echo "=== scenario 1: 実態の settings.json が不変条件を満たす ==="
RESULT="$(check "$SETTINGS")"
printf '%s\n' "$RESULT" | grep -v '^violations=' || true
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=0" ]; then
  ok "違反なし（SessionStart $(jq '.hooks.SessionStart | length' "$SETTINGS") エントリ）"
else
  ng "違反あり" "$(printf '%s\n' "$RESULT" | tail -n1)"
fi

echo "=== scenario 2: fixture で違反を検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# 違反 4 種: matcher 無し / compact で警告も実行 / startup で reinject 実行 / reinject の警告系エントリしか無い fork
cat > "$WORK/bad.json" <<'EOF'
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/check-a.sh" } ] },
      { "matcher": "startup|resume|clear|compact", "hooks": [
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/check-b.sh" },
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/reinject-aidd-run-state.sh" }
      ] }
    ]
  }
}
EOF
RESULT="$(check "$WORK/bad.json")"
for needle in 'no-matcher:' 'compact-noise:' 'reinject-on-startup:' 'missing-fork:'; do
  if printf '%s\n' "$RESULT" | grep -qF "$needle"; then ok "検知: $needle"; else ng "検知できない: $needle" "$RESULT"; fi
done

cat > "$WORK/good.json" <<'EOF'
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|clear|fork", "hooks": [ { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/check-a.sh" } ] },
      { "matcher": "compact", "hooks": [ { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/reinject-aidd-run-state.sh" } ] }
    ]
  }
}
EOF
RESULT="$(check "$WORK/good.json")"
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=0" ]; then ok "正しい構成は誤検知しない"; else ng "正しい構成を誤検知" "$RESULT"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
