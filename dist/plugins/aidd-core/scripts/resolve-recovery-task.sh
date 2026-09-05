#!/usr/bin/env bash
set -euo pipefail

# WHY: issue #579。scripts/queue-recovery-task.sh/scripts/check-recovery-queue.sh（issue #523）は
# 検知→登録→次回セッションへの表示までを機械化したが、「対応後は手動でキューから該当行を削除する」
# 運用が残っていた（docs/agents/recovery-queue.md「安全上の制約」既知の限界1点目）。
# 削除ではなく status を "resolved" に書き換えて resolvedAt を追記する方式にしたのは、
# .aidd/recovery-queue.jsonl を追記専用の監査ログとして扱い、「いつ何を対応したか」を
# 後から追える形にするため（削除だと対応履歴が残らない）。
#
# 使い方（パイプ・stdinは使わない）:
#   scripts/resolve-recovery-task.sh --id ID [--queue-file PATH]

QUEUE_FILE="${RECOVERY_QUEUE_FILE:-.aidd/recovery-queue.jsonl}"
ID=""

usage() {
  echo "Usage: $0 --id ID [--queue-file PATH]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id) ID="$2"; shift 2 ;;
    --queue-file) QUEUE_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

if [[ -z "$ID" ]]; then
  usage
fi

if [[ ! -f "$QUEUE_FILE" ]]; then
  echo "Queue file not found: $QUEUE_FILE" >&2
  exit 1
fi

MATCH_COUNT="$(jq -R -r --arg id "$ID" 'fromjson? | select(.id == $id)' "$QUEUE_FILE" 2>/dev/null | jq -s 'length' 2>/dev/null || echo 0)"
case "$MATCH_COUNT" in
  ''|*[!0-9]*) MATCH_COUNT=0 ;;
esac

if [[ "$MATCH_COUNT" -eq 0 ]]; then
  echo "No entry found for id: $ID" >&2
  exit 1
fi

RESOLVED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
TMP_FILE="$(mktemp "$(dirname "$QUEUE_FILE")/.recovery-queue.XXXXXX")"

jq -R -r --arg id "$ID" --arg resolvedAt "$RESOLVED_AT" \
  'fromjson? | if .id == $id then (.status = "resolved") + {resolvedAt: $resolvedAt} else . end | tostring' \
  "$QUEUE_FILE" > "$TMP_FILE"
mv "$TMP_FILE" "$QUEUE_FILE"

echo "Resolved: $ID"
