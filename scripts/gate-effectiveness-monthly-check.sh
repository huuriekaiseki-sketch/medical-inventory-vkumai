#!/usr/bin/env bash
set -euo pipefail

# Stop hookから呼ばれる。issue #412: 品質ゲート（reviewer/implementer/judge-panel）の
# pass/fail実績を、人が思い出して実行する運用にせず機械トリガー（Stop hook）で月次集計する。
#
# 起動はセッション終了のたびだが、実際にsystemMessageを出すのは前回出力から30日以上
# 経過した場合のみ（状態は.claude/.gate-effectiveness-state/last-summary-atのmtimeで判定）。
# これにより「Stop hookは毎回発火する（機械トリガー）が、通知は月次に間引く」を両立する。
#
# 対象外: aidd-phase2.jsのSpec Check/Manifest Check等が返すblocked状態は
# logs/loop-observability.jsonlに記録されないため、この集計には現れない
# （scripts/log-loop-observability.shの--resultはpass|failのみ受け付ける。issue #412コメント参照）。

cd "$(dirname "$0")/.."

LOG_FILE="logs/loop-observability.jsonl"
if [ ! -f "$LOG_FILE" ]; then
  echo '{"systemMessage": ""}'
  exit 0
fi

STATE_DIR=".claude/.gate-effectiveness-state"
STATE_FILE="$STATE_DIR/last-summary-at"
mkdir -p "$STATE_DIR"

INTERVAL_DAYS=30

if [ -f "$STATE_FILE" ]; then
  # find -mtime +N は「N日より古い」判定。該当すればstdoutに1行出る
  STALE="$(find "$STATE_FILE" -mtime "+${INTERVAL_DAYS}" 2>/dev/null || true)"
  if [ -z "$STALE" ]; then
    echo '{"systemMessage": ""}'
    exit 0
  fi
fi

SUMMARY="$(bash scripts/summarize-loop-observability.sh --log-file "$LOG_FILE" 2>/dev/null || true)"
touch "$STATE_FILE"

if [ -z "$SUMMARY" ]; then
  echo '{"systemMessage": ""}'
  exit 0
fi

MSG="品質ゲート月次サマリ（issue #412。blocked状態は対象外、reviewer/implementer/judge-panelのpass/failのみ）:

${SUMMARY}"

jq -n --arg msg "$MSG" '{systemMessage: $msg}'
