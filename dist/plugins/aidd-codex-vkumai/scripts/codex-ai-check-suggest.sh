#!/usr/bin/env bash
set -euo pipefail

# Codex の Stop hook。ソースを変えたのに品質チェックを打っていないなら警告する。
# 相方は scripts/codex-ai-check-track.sh（PostToolUse）が残したハッシュ。
#
# WHY(2026-09-11、派生先からの逆輸入): Codex 側には Stop hook が 1 本も無く、
#   **セッション終了時の警告が Codex には一切出ていなかった**。
#   同じ人が同じリポジトリを触っていても、使うツールで守りの厚みが変わっていた。
#
# WHY(警告のみ): Claude 側の `ai-check-suggest.sh` と同じで、止めない。
#   打つかどうかは人が決める（`ai:check` は E2E まで通すので数分かかる）。
#
# 環境変数（テスト用の注入ポイント）:
#   CODEX_AI_CHECK_STATE_DIR   状態ファイルの置き場（既定 .codex/.ai-check-suggest-state）
#
# 限界:
#   - **打った「後」に触ったかしか見ない。** 打った内容が緑だったかは見ない（それは記録の担当）
#   - `.ts` / `.tsx` / `.sql` だけを見る。docs や設定だけの変更では何も言わない
#   - PostToolUse が動いていない環境（jq が無い等）や、記録の置き場に書けない環境
#     （読み取り専用など）では記録が無く、**毎回警告する側に倒れる**
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO_ROOT" ] || exit 0
cd "$REPO_ROOT" || exit 0

INPUT="$(cat)"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')"

# WHY(読むだけ): ここで置き場を作ったり古い記録を消したりすると、書けない環境で
#   `set -e` に引っかかって hook そのものが失敗として終わり、Codex の画面に
#   「hook が失敗しました」と出る（2026-09-29 実測で rc=1）。知らせるだけの hook は
#   自分の都合で失敗しない。置き場の用意と掃除は、書く側（codex-ai-check-track.sh）だけが行う。
STATE_DIR="${CODEX_AI_CHECK_STATE_DIR:-.codex/.ai-check-suggest-state}"
STATE_FILE="$STATE_DIR/${SESSION_ID}.hash"

STATUS="$(git status --porcelain -- '*.ts' '*.tsx' '*.sql' 2>/dev/null || true)"
UNTRACKED="$(git ls-files --others --exclude-standard -- '*.ts' '*.tsx' '*.sql' 2>/dev/null || true)"
# ソースに触っていないなら言うことは無い
if [ -z "$STATUS" ] && [ -z "$UNTRACKED" ]; then
  exit 0
fi

CURRENT_HASH="$({
  printf '%s\n' "$STATUS"
  git diff --binary HEAD -- '*.ts' '*.tsx' '*.sql' 2>/dev/null || true
  while IFS= read -r -d '' file; do
    printf 'untracked:%s\n' "$file"
    shasum -a 256 -- "$file" 2>/dev/null || true
  done < <(git ls-files --others --exclude-standard -z -- '*.ts' '*.tsx' '*.sql' 2>/dev/null)
} | shasum -a 256 | awk '{print $1}')"

RECORDED_HASH=""
[ -f "$STATE_FILE" ] && RECORDED_HASH="$(cat "$STATE_FILE" 2>/dev/null || true)"

# 打った時点の姿と、いまの姿が同じなら「打ってある」
[ "$RECORDED_HASH" = "$CURRENT_HASH" ] && exit 0

MSG="[Codex] ソース（.ts / .tsx / .sql）を変えていますが、このセッションで品質チェックを打った形跡がありません。
打っていれば、その後に触った分だけが残っています。
  npm run typecheck / npm run lint / npm test
  まとめて: npm run ai:check（統合テストと E2E まで通すので数分かかります）"

jq -n --arg msg "$MSG" '{systemMessage: $msg}'
