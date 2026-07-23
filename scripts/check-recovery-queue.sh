#!/usr/bin/env bash
set -euo pipefail

# WHY: issue #523。.aidd/recovery-queue.jsonl（scripts/queue-recovery-task.shが追記する）に
# status="pending"のエントリが溜まっていないかをSessionStart時に確認し、あればcontextへ
# 注入する。人間がwarningを読んで指示するのを待たず、次のセッション開始時点で自動的に
# 「何を復旧すべきか」が目の前に出てくることで、検知→復旧の閉ループを1段階前進させる。
#
# 設計方針:
# - このhook自体は復旧作業を実行しない（自律実行はセッション本体が行う）。役割は
#   「pendingエントリの存在をセッション冒頭のcontextへ確実に届けること」に限定する
# - 注入時にstatusを"pending"から"surfaced"へ書き換える（同一エントリを毎セッション
#   繰り返し表示しないため）。"surfaced"→"resolved"への遷移は今回のスコープ外
#   （docs/agents/recovery-queue.md「既知の未対応」参照。人間・エージェントいずれかが
#   対応後に手動でキューから該当行を削除する運用を暫定とする）
# - fail-open: 判定材料が取れないケース（jq不在・キューファイル無し等）はすべて沈黙する
# - 全経路 exit 0（block不可）
#
# 環境変数（テスト用の注入ポイント）:
#   RECOVERY_QUEUE_FILE  キューファイルパス（既定 .aidd/recovery-queue.jsonl）

cd "$(dirname "$0")/.."

QUEUE_FILE="${RECOVERY_QUEUE_FILE:-.aidd/recovery-queue.jsonl}"

command -v jq >/dev/null 2>&1 || exit 0
[ -f "$QUEUE_FILE" ] || exit 0

PENDING_COUNT="$(jq -R -r 'fromjson? | select(.status == "pending")' "$QUEUE_FILE" 2>/dev/null | jq -s 'length' 2>/dev/null || echo 0)"
case "$PENDING_COUNT" in
  ''|*[!0-9]*) PENDING_COUNT=0 ;;
esac

[ "$PENDING_COUNT" -gt 0 ] || exit 0

SUMMARY="$(jq -R -r 'fromjson? | select(.status == "pending") | "- [\(.type)] \(.timestamp): \(.detail | tostring)"' "$QUEUE_FILE" 2>/dev/null || true)"

# statusを"pending"→"surfaced"に書き換えて再書き込みする（他行は無変更）。
# 書き込みに失敗しても（disk full・read-only等）クラッシュせず、次回もpendingのまま
# 再表示されるだけで実害は軽微なため、fail-openでそのまま進める
TMP_FILE="$(mktemp "$(dirname "$QUEUE_FILE")/.recovery-queue.XXXXXX" 2>/dev/null || true)"
if [ -n "$TMP_FILE" ]; then
  if jq -R -r 'fromjson? | if .status == "pending" then (.status = "surfaced") else . end | tostring' "$QUEUE_FILE" > "$TMP_FILE" 2>/dev/null; then
    mv "$TMP_FILE" "$QUEUE_FILE" 2>/dev/null || rm -f "$TMP_FILE"
  else
    rm -f "$TMP_FILE"
  fi
fi

MSG="未対応の復旧タスクが${PENDING_COUNT}件あります（.aidd/recovery-queue.jsonl、issue #523）。停止①②・サーキットブレーカーを迂回しない範囲で、内容を確認し対応してください（対応後はキューから該当行を削除してください。自動クローズは未実装）:
${SUMMARY}"
jq -n --arg msg "$MSG" '{systemMessage: $msg}'

exit 0
