#!/usr/bin/env bash
set -euo pipefail

# SessionStart hookから呼ばれる。issue #453: `blocked`ラベルの再開条件（docs/agents/decisions.md
# に記載）を誰がいつ見直すかの仕組みが無かった。issue本文の3案のうち、
# 「Claude Codeのリリースノートを定期的に確認する仕組み」は常時監視として過剰、
# 「気づいたら見る」は検知手段のないルールを増やすだけ（issue #339の棚卸し対象が増える）ため
# 見送り、案3（再確認の目安時期をトリガーにする）をセッション起動時のポーリングという形で
# 機械化した。cron等の常時稼働は導入せず、check-otel-collector-status.sh等と同じ
# 「セッションが始まった時に気づける」最小限のバーに留める（issue #411原則）。
#
# `blocked`ラベルの付いたOPEN issueのうち、最終更新（updatedAt）が既定90日以上前のものを
# 警告する。block（session開始そのものの停止）はできない前提のためwarningのみ。
#
# 日付計算はmacOS(BSD date)とLinux(GNU date)でdate -d/-jの互換性が無いため、
# このリポジトリの他スクリプト（check-run-manifest-presence.sh等）と同様にpython3に委ねる。

STALE_DAYS="${BLOCKED_ISSUE_STALE_DAYS:-90}"

if ! [[ "$STALE_DAYS" =~ ^[0-9]+$ ]]; then
  STALE_DAYS=90
fi

if ! command -v gh >/dev/null 2>&1; then
  exit 0
fi

ISSUES_JSON="$(gh issue list --label blocked --state open --json number,title,updatedAt,url --limit 20 2>/dev/null || echo '[]')"

if [ -z "$ISSUES_JSON" ]; then
  ISSUES_JSON='[]'
fi

STALE_JSON="$(printf '%s' "$ISSUES_JSON" | python3 -c "
import json, sys
from datetime import datetime, timezone, timedelta

issues = json.load(sys.stdin)
threshold = datetime.now(timezone.utc) - timedelta(days=$STALE_DAYS)
stale = []
for issue in issues:
    updated = datetime.fromisoformat(issue['updatedAt'].replace('Z', '+00:00'))
    if updated < threshold:
        stale.append(issue)
print(json.dumps(stale))
" 2>/dev/null || echo '[]')"

if [ -z "$STALE_JSON" ]; then
  STALE_JSON='[]'
fi

COUNT="$(printf '%s' "$STALE_JSON" | jq 'length' 2>/dev/null || echo 0)"

if [ "$COUNT" = "0" ] || [ -z "$COUNT" ]; then
  exit 0
fi

SUMMARY="$(printf '%s' "$STALE_JSON" | jq -r '.[] | "- #\(.number) \(.title) (\(.url))"')"

MSG="blockedラベルの付いたissueが${STALE_DAYS}日以上更新されていません。再開条件（docs/agents/decisions.mdに記載）を満たすようになっていないか確認してください（issue #453）。
${SUMMARY}"

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $msg
  }
}'
