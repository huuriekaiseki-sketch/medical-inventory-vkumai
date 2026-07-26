#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/agent-progress.jsonl"
STALE_SECONDS=180
NOW_EPOCH=""

usage() {
  echo "Usage: $0 [--log-file PATH] [--stale-seconds N] [--now-epoch N]" >&2
  echo "  --stale-seconds N  この秒数を超えて更新がないrunning/waiting/starting中のエージェントを「止まってる？」と表示する（既定: 180）" >&2
  echo "  --now-epoch N      現在時刻をUNIX epoch秒で上書きする（主にテスト用）" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --stale-seconds) STALE_SECONDS="$2"; shift 2 ;;
    --now-epoch) NOW_EPOCH="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

if [[ -z "$NOW_EPOCH" ]]; then
  NOW_EPOCH="$(date -u +%s)"
fi

if [[ ! -f "$LOG_FILE" ]]; then
  echo "進捗ログがありません: $LOG_FILE（エージェントがまだ進捗報告していない可能性があります）"
  exit 0
fi

jq -s -r --argjson now "$NOW_EPOCH" --argjson stale "$STALE_SECONDS" '
  def epoch: (. | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime);
  group_by(.agent)
  | map(sort_by(.timestamp) | .[-1])
  | sort_by(.agent)
  | .[]
  | . as $e
  | ($e.timestamp | epoch) as $t
  | ($now - $t) as $ageSec
  | if ($e.status != "done" and $e.status != "failed" and $ageSec > $stale)
    then "\($e.agent)：止まってる？（\($ageSec)秒応答なし）"
    elif $e.status == "done" then "\($e.agent)：\($e.note) ✓"
    elif $e.status == "failed" then "\($e.agent)：\($e.note) ✗"
    else "\($e.agent)：\($e.note)"
    end
' "$LOG_FILE"
