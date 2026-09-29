#!/usr/bin/env bash
set -euo pipefail

# WHY: 警告専用（ブロックしない）hook。jq 不在では静かに exit 0（issue #636 と同じ方針）。
command -v jq >/dev/null 2>&1 || exit 0

# SessionStart hook から呼ばれる。鍵・権限・token の四半期棚卸し（docs/agents/access-review-runbook.md、
# issue #757 の 36）は「作った日から古くなる」もので、期限の無い token や使われない権限は漏れても
# 気づく手段が無いまま残る。依存の月次棚卸し（scripts/check-dependency-update-staleness.sh）と同じ型で
# 「## 次回実施予定日」を過ぎていたら警告する。
#
# 環境変数（テスト用の注入ポイント）:
#   ACCESS_REVIEW_DOC  対象ドキュメント（既定 docs/agents/access-review-runbook.md）

RUNBOOK="${ACCESS_REVIEW_DOC:-docs/agents/access-review-runbook.md}"

if [ ! -f "$RUNBOOK" ]; then
  exit 0
fi

RESULT="$(python3 -c "
import re, sys
from datetime import date

with open('$RUNBOOK', encoding='utf-8') as f:
    text = f.read()

m = re.search(r'## 次回実施予定日\s*\n+(\d{4}-\d{2}-\d{2})', text)
if not m:
    print('NO_DATE')
    sys.exit(0)

due = date.fromisoformat(m.group(1))
today = date.today()
if today >= due:
    print(f'DUE {due.isoformat()} {(today - due).days}')
else:
    print('OK')
" 2>/dev/null || echo 'OK')"

if [ "$RESULT" = "OK" ]; then
  exit 0
fi

if [ "$RESULT" = "NO_DATE" ]; then
  MSG="${RUNBOOK}の「## 次回実施予定日」欄から日付を読み取れませんでした。書式が崩れていないか確認してください。"
  jq -n --arg msg "$MSG" '{
    systemMessage: $msg,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg }
  }'
  exit 0
fi

DUE_DATE="$(printf '%s' "$RESULT" | cut -d' ' -f2)"
DAYS_OVERDUE="$(printf '%s' "$RESULT" | cut -d' ' -f3)"

MSG="鍵・権限・token の四半期棚卸し（${RUNBOOK}）の次回実施予定日（${DUE_DATE}）を${DAYS_OVERDUE}日過ぎています。同ファイルの手順で未使用の公開 RPC・admin 利用者・ADMIN_EMAILS・token の scope と期限・SSH 鍵を確認し、結果と次回予定日を更新してください（docs/agents/access-review-runbook.md「## 次回実施予定日」）。"

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg }
}'
