#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなっていた（issue #636）。
# ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

# Stop hookから呼ばれる。issue #412: 品質ゲート（reviewer/implementer/judge-panel）の
# pass/fail実績を、人が思い出して実行する運用にせず機械トリガー（Stop hook）で月次集計する。
#
# 起動はセッション終了のたびだが、実際にsystemMessageを出すのは前回出力から30日以上
# 経過した場合のみ（状態は.claude/.gate-effectiveness-state/last-summary-atのmtimeで判定）。
# これにより「Stop hookは毎回発火する（機械トリガー）が、通知は月次に間引く」を両立する。
#
# 追記（issue #642）: agent別pass/fail集計は自己申告のloop-observability.jsonlではなく、
# 機械記録のWorkflow journalベースへ移行した。journal(wf_*ディレクトリ)はtranscript cleanupで
# 消えるため、30日通知ゲートとは無関係に毎回、logs/journal-harvest.jsonlへ収穫してから集計する
# （scripts/harvest-journal-events.sh → scripts/summarize-gate-passfail.sh。旧
# summarize-gate-blocked.sh=blockedのみの別枠集計は新集計へ統合し廃止）。feature別・コスト集計は
# 引き続きloop-observability.jsonl(自己申告・欠落あり得る)参照のため、その旨をMSG内に注記する。
# いずれもnpx/tsx不在等で失敗しても本hook自体は落とさずfail-open。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"
cd "$SCRIPT_DIR/.."

# 収穫は通知の30日間引きより前に毎回行う（journalが消える前に確保することが目的のため、
# 通知が出ない回でも収穫だけは進める。issue #642 Stage 1）
bash "$SCRIPT_DIR/harvest-journal-events.sh" >/dev/null 2>&1 || true

LOG_FILE="$(resolve_log_dir)/loop-observability.jsonl"
if [ ! -f "$LOG_FILE" ]; then
  :  # 報告事項なし。公式仕様では表示しないなら systemMessage を省略する（issue #737。以前は空文字を出していた）
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
    :  # 報告事項なし。公式仕様では表示しないなら systemMessage を省略する（issue #737。以前は空文字を出していた）
    exit 0
  fi
fi

SUMMARY="$(bash scripts/summarize-loop-observability.sh --log-file "$LOG_FILE" 2>/dev/null || true)"
PASSFAIL_SUMMARY="$(bash "$SCRIPT_DIR/summarize-gate-passfail.sh" 2>/dev/null || true)"
touch "$STATE_FILE"

if [ -z "$SUMMARY" ] && [ -z "$PASSFAIL_SUMMARY" ]; then
  :  # 報告事項なし。公式仕様では表示しないなら systemMessage を省略する（issue #737。以前は空文字を出していた）
  exit 0
fi

MSG="品質ゲート月次サマリ（issue #412）:

## agent別pass/fail/blocked（収穫済みjournalベース＝機械記録、issue #642）
${PASSFAIL_SUMMARY:-（取得できませんでした。npx/tsxが利用できない可能性があります）}

## feature別・コスト集計（loop-observability.jsonlベース＝自己申告。記録漏れによる欠落があり得るため、件数ゼロを「発火ゼロ」と読まないこと）
${SUMMARY}"

jq -n --arg msg "$MSG" '{systemMessage: $msg}'
