#!/usr/bin/env bash
# WHY: issue #757 の 33（人間系の回避経路）。安全装置（ask hook・RLS・CI・停止①・DDL の deny 等）を人が
#      意図的に迂回したとき、「迂回したこと自体」を残す入口。監査ログ（audit_log）は DB の変更を記録するが
#      「なぜ手動でやったか」は書けず、hook の警告はセッションの中で消える。ここに 1 行残しておけば、
#      後から「その日の Studio での UPDATE は緊急対応だった」と説明できる（docs/agents/human-bypass-inventory.md）。
#
# 使い方:
#   bash scripts/log-manual-override.sh --safeguard H-009 --actor masanori --reason "本番の価格を Studio で手修正（発注が止まっていたため）" [--ref "issue #123"]
# 記録先: <logs dir>/manual-overrides.jsonl（scripts/lib/resolve-log-dir.sh が解決。worktree 横断で 1 か所）
# --safeguard は docs/agents/human-bypass-inventory.md の H-xxx
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="${MANUAL_OVERRIDE_LOG_FILE:-$(resolve_log_dir)/manual-overrides.jsonl}"
SAFEGUARD=""
ACTOR=""
REASON=""
REF=""

usage() {
  echo "Usage: $0 --safeguard H-xxx --actor NAME --reason TEXT [--ref TEXT] [--log-file PATH]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --safeguard) SAFEGUARD="$2"; shift 2 ;;
    --actor) ACTOR="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

for name in SAFEGUARD ACTOR REASON; do
  if [[ -z "${!name}" ]]; then
    echo "Missing required argument: --$(echo "$name" | tr '[:upper:]' '[:lower:]')" >&2
    usage
  fi
done

if ! [[ "$SAFEGUARD" =~ ^H-[0-9]{3}$ ]]; then
  echo "--safeguard は H-3桁（docs/agents/human-bypass-inventory.md の ID）で指定してください: $SAFEGUARD" >&2
  exit 1
fi

command -v jq >/dev/null 2>&1 || { echo "jq が必要です" >&2; exit 1; }

mkdir -p "$(dirname "$LOG_FILE")"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
BRANCH="$(git -C "$SCRIPT_DIR/.." rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

jq -nc \
  --arg timestamp "$TIMESTAMP" \
  --arg safeguard "$SAFEGUARD" \
  --arg actor "$ACTOR" \
  --arg reason "$REASON" \
  --arg ref "$REF" \
  --arg branch "$BRANCH" \
  '{timestamp: $timestamp, safeguard: $safeguard, actor: $actor, reason: $reason, ref: $ref, branch: $branch}' \
  >> "$LOG_FILE"

echo "記録しました: ${LOG_FILE}（$SAFEGUARD / ${ACTOR}）"
