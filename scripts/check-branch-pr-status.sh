#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなっていた（issue #636）。
# ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

# WHY: docs/agents/common.md「ブランチ運用ルール」（新しいissue・機能の作業を始める前に、
# 現在のブランチが別issue用の未マージPRの対象になっていないか確認する）には、これまで
# 検知手段がなかった（自然言語指示のみ）。実際にissue-20-orders-list-page等、既にPRが
# マージ済みのブランチ上で並行して重複作業が発生し、無駄なworktreeが複数残る実害が
# 発生したため、SessionStart hookで機械的に警告する。
# block（session開始そのものの停止）はできない前提のためwarningのみ。
#
# 設計: docs/agents/common.md「検知手段のないルールの棚卸し（issue #339）」表の
# 「ブランチ運用ルール」行を参照。

# WHY(issue #420): プラグイン配布ではスクリプト位置がリポジトリ外になるため CLAUDE_PROJECT_DIR を優先する
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"

BRANCH="$(git branch --show-current 2>/dev/null || true)"

if [ -z "$BRANCH" ] || [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  exit 0
fi

MERGED_PRS="$(gh pr list --head "$BRANCH" --state merged --json number,title,url --limit 3 2>/dev/null || echo '[]')"

if [ -z "$MERGED_PRS" ]; then
  MERGED_PRS='[]'
fi

COUNT="$(printf '%s' "$MERGED_PRS" | jq 'length' 2>/dev/null || echo 0)"

if [ "$COUNT" = "0" ] || [ -z "$COUNT" ]; then
  exit 0
fi

SUMMARY="$(printf '%s' "$MERGED_PRS" | jq -r '.[] | "- #\(.number) \(.title) (\(.url))"')"

MSG="現在のブランチ「${BRANCH}」は既に以下のPRでマージ済みです。このまま新しいissue・機能の作業を続けると、レビュー時に既マージ分の差分が混在したり、既に他の作業で解決済みの内容を重複実装する恐れがあります。着手前に \`git fetch origin main\` → \`git checkout -b <new-branch> origin/main\` で新しいブランチを作成することを検討してください（docs/agents/common.md「ブランチ運用ルール」参照）。
${SUMMARY}"

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $msg
  }
}'
