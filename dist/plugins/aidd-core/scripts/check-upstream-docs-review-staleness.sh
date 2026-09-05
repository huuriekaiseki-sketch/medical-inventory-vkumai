#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなっていた（issue #636）。
# ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

# SessionStart hookから呼ばれる。公式ドキュメント（Claude Code / Anthropic / Codex）の差分確認
# （docs/agents/upstream-docs-review.md）は「1 回やって終わり」になりやすい第3層ルールのため、
# fault-injection 訓練（scripts/check-fault-injection-drill-staleness.sh、issue #443）と同じ型で
# 「## 次回実施予定日」を過ぎていたら警告する。2026-09-05 に、7 月に調べた推奨事項の再確認で
# v1 プラグイン設計に効く制約 3 件と取り込む価値のある新機能 4 件が見つかった実績があり、
# 差分確認自体を定期化する価値が実測で確認できたため導入した。
#
# 日付抽出はmacOS/Linuxのdate非互換を避けるため他のスクリプトと同様にpython3に委ねる。
#
# 環境変数（テスト用の注入ポイント）:
#   UPSTREAM_DOCS_REVIEW_DOC  対象ドキュメント（既定 docs/agents/upstream-docs-review.md）

REVIEW_DOC="${UPSTREAM_DOCS_REVIEW_DOC:-docs/agents/upstream-docs-review.md}"

if [ ! -f "$REVIEW_DOC" ]; then
  exit 0
fi

RESULT="$(python3 -c "
import re, sys
from datetime import date

with open('$REVIEW_DOC', encoding='utf-8') as f:
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
  MSG="${REVIEW_DOC}の「## 次回実施予定日」欄から日付を読み取れませんでした。書式が崩れていないか確認してください。"
  jq -n --arg msg "$MSG" '{
    systemMessage: $msg,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg }
  }'
  exit 0
fi

DUE_DATE="$(printf '%s' "$RESULT" | cut -d' ' -f2)"
DAYS_OVERDUE="$(printf '%s' "$RESULT" | cut -d' ' -f3)"

MSG="公式ドキュメント差分の定期確認（${REVIEW_DOC}）の次回実施予定日（${DUE_DATE}）を${DAYS_OVERDUE}日過ぎています。同ファイルの手順で Claude Code changelog / docs・Anthropic engineering・Codex changelog の差分を確認し、実施記録・「最後に確認した版」・次回予定日を更新してください（docs/agents/upstream-docs-review.md「## 次回実施予定日」）。"

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg }
}'
