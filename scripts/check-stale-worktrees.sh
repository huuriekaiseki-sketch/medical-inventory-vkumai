#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなる（issue #636と同種の対策）。
# ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq/git/gh不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0
command -v gh >/dev/null 2>&1 || exit 0

# WHY: issue #674。2026-08-27の棚卸しで、worktree13個中8個が用済み（対応PRマージ済み）、
# ローカルブランチ96件が残骸（リモート削除済みのgone）と判明した。既存のSessionStart hook
# （check-branch-pr-status.sh・check-local-main-freshness.sh）は「今いるブランチ」しか
# 見ておらず、リポジトリ全体の残骸蓄積は検知対象外だった。
#
# 検知内容:
# 1. `git worktree list`の各worktreeのブランチについて、対応PRがマージ/クローズ済みかを
#    gh pr listで確認し、該当worktree数を警告する（API呼び出しはworktree数に上限を設けて抑制）
# 2. `git branch -vv`の「gone」表示（リモート追跡先が削除済み）ブランチ数が閾値を超えたら
#    件数警告する
#
# 設計方針:
# - fail-open: git/gh/jq不在・API失敗・タイムアウトはすべて沈黙する。警告機能の故障で
#   セッションを妨げない
# - 警告は同一セッションにつき1回のみ（.aidd/check-stale-worktrees-warning-shown.json の
#   マーカーで抑止。書き込みは一時ファイル→mvのatomic方式。既存4スクリプト
#   （check-aidd-stats-recorded.sh等）と同一パターン）
# - 全経路 exit 0（blockしない）。是正（worktree削除・ブランチ削除）の実行は完全に人間の
#   裁量に委ねる（worktree/ブランチの削除は不可逆に近い操作のため機械強制しない）
#
# 環境変数（テスト用の注入ポイント）:
#   STALE_WORKTREES_SESSION_ID     hook stdinのsession_idの代替
#   STALE_WORKTREES_MARKER_FILE    警告済みマーカー（既定 .aidd/check-stale-worktrees-warning-shown.json）
#   STALE_WORKTREES_MAX_CHECK      PR状態を確認するworktree数の上限（既定10、API呼び出し抑制）
#   STALE_WORKTREES_GONE_THRESHOLD goneブランチ数の警告閾値（既定10）

cd "$(dirname "$0")/.."

MARKER_FILE="${STALE_WORKTREES_MARKER_FILE:-.aidd/check-stale-worktrees-warning-shown.json}"
MAX_CHECK="${STALE_WORKTREES_MAX_CHECK:-10}"
GONE_THRESHOLD="${STALE_WORKTREES_GONE_THRESHOLD:-10}"

# hook入力（stdin JSON）からsession_idを取得（テスト時は環境変数で代替）
if [ -z "${STALE_WORKTREES_SESSION_ID:-}" ]; then
  HOOK_INPUT="$(cat 2>/dev/null || true)"
  SESSION_ID="$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)"
else
  SESSION_ID="$STALE_WORKTREES_SESSION_ID"
fi
[ -n "$SESSION_ID" ] || exit 0

# 警告済みマーカー: 同一セッションでは2回目以降沈黙
if [ -f "$MARKER_FILE" ]; then
  WARNED_SESSION="$(jq -r '.sessionId // empty' "$MARKER_FILE" 2>/dev/null || true)"
  if [ "$WARNED_SESSION" = "$SESSION_ID" ]; then
    exit 0
  fi
fi

# 1. worktreeごとにマージ/クローズ済みPRの有無を確認する（1worktreeあたりAPI呼び出し1回。
#    --state all + jqでの絞り込みにより merged/closed を1リクエストにまとめる）
STALE_WORKTREE_COUNT=0
CHECKED=0
set +e
WORKTREE_LIST="$(git worktree list --porcelain 2>/dev/null)"
while IFS= read -r line; do
  case "$line" in
    "branch refs/heads/"*)
      BRANCH="${line#branch refs/heads/}"
      if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
        continue
      fi
      if [ "$CHECKED" -ge "$MAX_CHECK" ]; then
        continue
      fi
      CHECKED=$((CHECKED + 1))
      PRS="$(gh pr list --head "$BRANCH" --state all --json state --limit 5 2>/dev/null)"
      [ -z "$PRS" ] && PRS='[]'
      DONE_COUNT="$(printf '%s' "$PRS" | jq '[.[] | select(.state == "MERGED" or .state == "CLOSED")] | length' 2>/dev/null)"
      if [ -n "$DONE_COUNT" ] && [ "$DONE_COUNT" != "0" ]; then
        STALE_WORKTREE_COUNT=$((STALE_WORKTREE_COUNT + 1))
      fi
      ;;
  esac
done <<EOF
$WORKTREE_LIST
EOF
set -e

# 2. goneブランチ（リモート追跡先が削除済み）の数。
# WHY: grep -c はマッチ0件でも標準出力に"0"を返す（終了コードは1になるが、これは
# 「マッチ0件」を示すだけで異常ではない）。ここで || echo 0 を足すと、grep自体は
# 正常終了しているのに"0"が二重出力される（0\n0 のような複数行）ため付けない。
# git自体が失敗した場合（コマンド不在等）のみ次行のデフォルト代入で0にする。
set +e
GONE_COUNT="$(git branch -vv 2>/dev/null | grep -c ': gone\]')"
set -e
[ -z "$GONE_COUNT" ] && GONE_COUNT=0

# どちらも該当なしなら何も出さず終了
if [ "$STALE_WORKTREE_COUNT" -eq 0 ] 2>/dev/null && [ "$GONE_COUNT" -lt "$GONE_THRESHOLD" ] 2>/dev/null; then
  exit 0
fi

# 警告前に、マーカーをatomicに書いてから1回だけ警告する
write_marker() {
  local dir tmp
  dir="$(dirname "$MARKER_FILE")"
  mkdir -p "$dir" 2>/dev/null || return 1
  tmp="$(mktemp "$dir/.check-stale-worktrees-warning.XXXXXX" 2>/dev/null)" || return 1
  jq -n --arg sid "$SESSION_ID" '{sessionId: $sid}' > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$MARKER_FILE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  return 0
}
set +e
write_marker
set -e

LINES=""
if [ "$STALE_WORKTREE_COUNT" -gt 0 ] 2>/dev/null; then
  LINES="${LINES}- 対応PRがマージ/クローズ済みのworktreeが${STALE_WORKTREE_COUNT}件あります（確認対象は先頭${CHECKED}件まで）。\`git worktree list\`で確認し、不要なら\`git worktree remove\`で削除してください。
"
fi
if [ "$GONE_COUNT" -ge "$GONE_THRESHOLD" ] 2>/dev/null; then
  LINES="${LINES}- リモート追跡先が削除済み（gone）のローカルブランチが${GONE_COUNT}件あります。\`git branch -vv | grep gone\`で確認し、不要なら\`git branch -D\`で削除してください。
"
fi

MSG="リポジトリ内にworktree・ローカルブランチの残骸が蓄積している可能性があります（issue #674）。
${LINES}この警告はセッションにつき1回のみ表示されます。削除は不可逆に近い操作のため、対応PRの状態やコミットの有無を確認してから行ってください。"

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $msg
  }
}'

exit 0
