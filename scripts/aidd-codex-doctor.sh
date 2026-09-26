#!/usr/bin/env bash
# Codex プラグインの配置・実行前提を、導入先の cwd から読み取り専用で診断する。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_HOOKS="$PLUGIN_DIR/hooks/hooks.json"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PROJECT_HOOKS="$REPO_ROOT/.codex/hooks.json"
HOOK_NAMES=(check-branch-pr-status.sh check-branch-tool-ownership.sh check-local-main-freshness.sh codex-skip-marker-deny.sh)

has_command() { command -v "$1" >/dev/null 2>&1; }
has_hook() {
  local file="$1" name="$2"
  [ -f "$file" ] && has_command jq &&
    jq -e --arg name "$name" '[.. | objects | .command? | strings | select(endswith("/scripts/" + $name) or contains("/scripts/" + $name + " "))] | length > 0' "$file" >/dev/null 2>&1
}

for name in "${HOOK_NAMES[@]}"; do
  if ! has_command jq; then
    echo "hook $name: 確認不能（jq なし）"
  elif has_hook "$PLUGIN_HOOKS" "$name"; then
    echo "hook $name: 含まれる"
  else
    echo "hook $name: 欠落または hooks.json を読めない"
  fi
done

# Codex の公開ドキュメントに、hook の信頼記録を読む安定した設定キー・CLI がない。
# enabled や plugin の存在を信頼済みと読み替えない。
echo "信頼状態: 不明（読み取り可能な公開インターフェースを確認できない）"

for tool in jq git gh python3; do
  if has_command "$tool"; then echo "実行系 $tool: あり"; else echo "実行系 $tool: なし"; fi
done
if ! has_command gh; then
  echo "実行系 gh 認証: 判定不可（gh なし）"
elif gh auth status >/dev/null 2>&1; then
  echo "実行系 gh 認証: 有効"
else
  echo "実行系 gh 認証: 無効または確認不能"
fi

if has_command git && git -C "$REPO_ROOT" rev-parse --verify refs/remotes/origin/main >/dev/null 2>&1; then
  echo "参照 origin/main: あり"
  HAVE_ORIGIN_MAIN=1
else
  echo "参照 origin/main: なし"
  HAVE_ORIGIN_MAIN=0
fi
FETCH_HEAD=""
if has_command git; then FETCH_HEAD="$(git -C "$REPO_ROOT" rev-parse --git-path FETCH_HEAD 2>/dev/null || true)"; fi
if [ -n "$FETCH_HEAD" ] && [[ "$FETCH_HEAD" != /* ]]; then FETCH_HEAD="$REPO_ROOT/$FETCH_HEAD"; fi
if [ -n "$FETCH_HEAD" ] && [ -f "$FETCH_HEAD" ]; then
  echo "参照 FETCH_HEAD: あり"
  HAVE_FETCH_HEAD=1
else
  echo "参照 FETCH_HEAD: なし"
  HAVE_FETCH_HEAD=0
fi

if ! has_command jq; then
  echo "二重登録: 確認不能（jq なし）"
elif [ ! -f "$PROJECT_HOOKS" ]; then
  echo "二重登録: なし（project hooks.json なし）"
elif ! jq empty "$PROJECT_HOOKS" >/dev/null 2>&1; then
  echo "二重登録: 確認不能（project hooks.json を読めない）"
else
  for name in "${HOOK_NAMES[@]}"; do
    if has_hook "$PLUGIN_HOOKS" "$name" && has_hook "$PROJECT_HOOKS" "$name"; then
      echo "二重登録 $name: 警告（project hook とプラグイン hook の両方に登録）"
    else
      echo "二重登録 $name: なし"
    fi
  done
fi

for name in "${HOOK_NAMES[@]}"; do
  missing=()
  has_command jq || missing+=("jq なし")
  if has_command jq && ! has_hook "$PLUGIN_HOOKS" "$name"; then missing+=("hook 欠落"); fi
  case "$name" in
    check-branch-pr-status.sh)
      has_command git || missing+=("git なし")
      has_command gh || missing+=("gh なし")
      if has_command gh && ! gh auth status >/dev/null 2>&1; then missing+=("gh 認証なし"); fi
      ;;
    check-branch-tool-ownership.sh)
      has_command git || missing+=("git なし")
      ;;
    check-local-main-freshness.sh)
      has_command git || missing+=("git なし")
      has_command python3 || missing+=("python3 なし")
      [ "$HAVE_ORIGIN_MAIN" -eq 1 ] || missing+=("origin/main なし")
      [ "$HAVE_FETCH_HEAD" -eq 1 ] || missing+=("FETCH_HEAD なし")
      ;;
  esac
  if [ "${#missing[@]}" -gt 0 ]; then
    reason="$(IFS='、'; echo "${missing[*]}")"
    echo "判定 $name: 判定しない（${reason}）"
  else
    echo "判定 $name: 実行前提あり（信頼状態は不明）"
  fi
done
