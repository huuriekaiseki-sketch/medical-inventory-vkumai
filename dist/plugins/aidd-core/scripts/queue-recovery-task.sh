#!/usr/bin/env bash
set -euo pipefail

# WHY: issue #523。既存の検知hook群（gap check・AIDD stats等）はすべてwarning-onlyで、
# 検知後の立て直しは人間がsystemMessageを読んで指示する前提だった。長時間の自律実行では
# 警告→人間対応待ちがスループットの律速になる。このスクリプトは汎用ヘルパーとして、
# 検知hookから呼ばれ .aidd/recovery-queue.jsonl に1エントリ追記する。
# 追記されたエントリは次回SessionStart時に scripts/check-recovery-queue.sh が読み、
# セッション冒頭のcontextへ注入する。実際の復旧作業はセッション自身が自律的に行う
# （このスクリプト自体は復旧を実行しない。キューへの登録のみ）。
#
# 第一弾の対象type: gap-check-followup（gap check警告からの記録漏れ調査）。
# 詳細な設計・スコープ（Workflow中断→resumeFromRunId再開を未実装とした理由を含む）は
# docs/agents/recovery-queue.md 参照。
#
# 使い方（パイプ・stdinは使わない。detail JSONは第4引数相当のオプションで渡す）:
#   scripts/queue-recovery-task.sh --type TYPE --detail '<JSON>' [--queue-file PATH]

QUEUE_FILE="${RECOVERY_QUEUE_FILE:-.aidd/recovery-queue.jsonl}"
TYPE=""
DETAIL=""

usage() {
  echo "Usage: $0 --type TYPE --detail '<JSON>' [--queue-file PATH]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type) TYPE="$2"; shift 2 ;;
    --detail) DETAIL="$2"; shift 2 ;;
    --queue-file) QUEUE_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

if [[ -z "$TYPE" || -z "$DETAIL" ]]; then
  usage
fi

if ! printf '%s' "$DETAIL" | jq empty 2>/dev/null; then
  echo "Invalid JSON for --detail: $DETAIL" >&2
  exit 1
fi

mkdir -p "$(dirname "$QUEUE_FILE")"

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
ID="${TIMESTAMP}-$$"

jq -nc \
  --arg id "$ID" \
  --arg timestamp "$TIMESTAMP" \
  --arg type "$TYPE" \
  --argjson detail "$DETAIL" \
  '{id: $id, timestamp: $timestamp, type: $type, detail: $detail, status: "pending"}' \
  >> "$QUEUE_FILE"
