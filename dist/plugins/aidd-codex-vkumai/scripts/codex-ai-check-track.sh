#!/usr/bin/env bash
set -euo pipefail

# Codex の PostToolUse hook。品質チェック（ai:check 相当）を打った時点の**ソースの姿**を記録する。
# 相方は scripts/codex-ai-check-suggest.sh（Stop hook）。
#
# WHY(2026-09-11、派生先からの逆輸入): Codex 側には Stop hook が 1 本も無く、
#   **セッション終了時の警告が Codex には一切出ていなかった**。Claude 側には
#   `ai-check-suggest.sh` があるので、同じ人が同じリポジトリを触っていても
#   「どちらのツールで作業したか」で守りの厚みが変わっていた。
#
# WHY(Claude 版をそのまま使えない): Claude 版は transcript を解析して「打ったか」を見る。
#   **Codex の transcript は形式が安定しない**ので、同じ手は使えない。
#   代わりに PostToolUse で「打った瞬間のソースの姿」を残し、Stop でいまの姿と比べる。
#   この 2 本組は派生先（EC サイト）で先に作られていたものを、vkumai の流儀へ直して持ち込んだ。
#
# WHY(内容までハッシュに入れる): 変更**ファイル名**だけを見ると、
#   `ai:check` の後に同じファイルを編集し続けたときに姿が変わらず、警告が出ない。
#   `git diff --binary` と未追跡ファイルの中身まで混ぜる。
#
# 環境変数（テスト用の注入ポイント）:
#   CODEX_AI_CHECK_STATE_DIR   状態ファイルの置き場（既定 .codex/.ai-check-suggest-state）
command -v jq >/dev/null 2>&1 || exit 0

INPUT="$(cat)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')"

[ "$TOOL_NAME" = "Bash" ] || exit 0

# WHY(統合テストも数える): vkumai の `ai:check` は typecheck / lint / test / 統合 / E2E を通す。
#   どれか 1 つでも打っていれば「見ている」とみなす（打っていないことだけを警告したい）。
CHECK_PATTERN='npm[[:space:]]+(run[[:space:]]+)?(ai:check|typecheck|lint|test|test:integration|test:e2e)\b|npx[[:space:]]+(vitest|tsc|playwright)\b'
grep -qE "$CHECK_PATTERN" <<<"$COMMAND" || exit 0

# WHY(git でルートを取る): Codex には CLAUDE_PROJECT_DIR が無い。`.codex/hooks.json` も
#   `$(git rev-parse --show-toplevel)` でパスを解決しており、worktree でも正しく効く。
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO_ROOT" ] || exit 0
cd "$REPO_ROOT" || exit 0

source_hash() {
  {
    git status --porcelain -- '*.ts' '*.tsx' '*.sql' 2>/dev/null || true
    git diff --binary HEAD -- '*.ts' '*.tsx' '*.sql' 2>/dev/null || true
    while IFS= read -r -d '' file; do
      printf 'untracked:%s\n' "$file"
      shasum -a 256 -- "$file" 2>/dev/null || true
    done < <(git ls-files --others --exclude-standard -z -- '*.ts' '*.tsx' '*.sql' 2>/dev/null)
  } | shasum -a 256 | awk '{print $1}'
}

STATUS="$(git status --porcelain -- '*.ts' '*.tsx' '*.sql' 2>/dev/null || true)"
UNTRACKED="$(git ls-files --others --exclude-standard -- '*.ts' '*.tsx' '*.sql' 2>/dev/null || true)"
# ソースに触っていないなら記録する意味が無い
[ -n "$STATUS" ] || [ -n "$UNTRACKED" ] || exit 0

STATE_DIR="${CODEX_AI_CHECK_STATE_DIR:-.codex/.ai-check-suggest-state}"
mkdir -p "$STATE_DIR"
# 7 日より古い状態ファイルは掃除する（セッションごとに増え続けるのを防ぐ）
find "$STATE_DIR" -name '*.hash' -mtime +7 -delete 2>/dev/null || true
printf '%s\n' "$(source_hash)" > "$STATE_DIR/${SESSION_ID}.hash"
