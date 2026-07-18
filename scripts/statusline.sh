#!/bin/bash
# issue #446: statuslineでcontext使用率・セッションコスト・レート制限使用率・現在ブランチを
# 常時可視化する。サーキットブレーカー運用（財布を守る）の可視化面が手動確認のみだった問題への対応。
#
# stdinで渡されるJSONフィールドはcode.claude.com/docs/en/statuslineで実在確認済み。
# rate_limitsはClaude.ai Pro/Max契約かつセッション最初のAPI応答後にのみ存在するため、
# `// empty`で欠落・null双方を許容する（公式ドキュメント推奨パターン）。
input=$(cat)

MODEL=$(echo "$input" | jq -r '.model.display_name // "?"')
CTX_PCT=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
COST=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
FIVE_H=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
SEVEN_D=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')

BRANCH=""
git rev-parse --git-dir > /dev/null 2>&1 && BRANCH=$(git branch --show-current 2>/dev/null)

LINE="[$MODEL]"
[ -n "$BRANCH" ] && LINE="$LINE branch:$BRANCH"
[ -n "$CTX_PCT" ] && LINE="$LINE ctx:$(printf '%.0f' "$CTX_PCT")%"
LINE="$LINE cost:$(printf '$%.2f' "$COST")"
[ -n "$FIVE_H" ] && LINE="$LINE 5h:$(printf '%.0f' "$FIVE_H")%"
[ -n "$SEVEN_D" ] && LINE="$LINE 7d:$(printf '%.0f' "$SEVEN_D")%"

echo "$LINE"
