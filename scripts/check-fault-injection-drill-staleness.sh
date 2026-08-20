#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなっていた（issue #636）。
# ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

# SessionStart hookから呼ばれる。issue #443: 「検知手段のないルールの棚卸し」（issue #339）の
# 第3層ルールのうち、fault injection四半期訓練（issue #395）は
# docs/agents/fault-injection-drill.md「## 次回実施予定日」に「リマインド機構は無い」と
# 明記されたまま放置されていた。
#
# 設計判断（issue #443スコープの絞り込み。詳細はdocs/agents/decisions.md参照）:
# issue原案は「OS launchd等による夜間バッチジョブ」を想定していたが、対象読者(loop-observability
# /agent-progress gap check)は単発フロー実行の前後差分が前提の設計で夜間バッチに転用できず、
# eval:workflowsの実行記録自体も存在しないため、今回実装可能なのは本チェック（fault injection
# 訓練の期限切れ検知）のみだった。OS launchdのような常時稼働・無人でGitHub issueを作成しうる
# 仕組みを新設するのではなく、SessionStart hook（既に機械トリガーとして扱われる。issue #411の
# 原則を満たす）で「次回実施予定日」を過ぎていないか警告する形に留めた
# （check-blocked-issues-staleness.shと同じ「セッションが始まった時に気づける」最小限のバー）。
#
# 日付抽出はmacOS/Linuxのdate非互換を避けるため他のスクリプトと同様にpython3に委ねる。

DRILL_DOC="${FAULT_INJECTION_DRILL_DOC:-docs/agents/fault-injection-drill.md}"

if [ ! -f "$DRILL_DOC" ]; then
  exit 0
fi

RESULT="$(python3 -c "
import re, sys
from datetime import date

with open('$DRILL_DOC', encoding='utf-8') as f:
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
  MSG="${DRILL_DOC}の「## 次回実施予定日」欄から日付を読み取れませんでした。書式が崩れていないか確認してください（issue #443）。"
  jq -n --arg msg "$MSG" '{
    systemMessage: $msg,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg }
  }'
  exit 0
fi

DUE_DATE="$(printf '%s' "$RESULT" | cut -d' ' -f2)"
DAYS_OVERDUE="$(printf '%s' "$RESULT" | cut -d' ' -f3)"

MSG="fault injection訓練（${DRILL_DOC}）の次回実施予定日（${DUE_DATE}）を${DAYS_OVERDUE}日過ぎています。4シナリオを実施し、実施記録欄への追記と次回予定日の更新（\`docs/agents/fault-injection-drill.md\`「## 次回実施予定日」）をお願いします（issue #443）。"

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg }
}'
