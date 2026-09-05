#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/agent-progress.jsonl"
STALE_SECONDS=180
# WHY: agent-progress.jsonl は追記のみで消えないため、数週間前のフローで running のまま終わった
#      エージェントが「止まってる？（3,460,274秒応答なし）」として永久に表示され続けていた
#      （2026-09-05、compaction 後の再注入（issue #712）で 40 日前の 3 件が毎回混ざるのを確認）。
#      一定期間より古い最終報告は「今のフローの状態」ではないので表示から落とす。
#      過去フローの done/failed も同様に落とす（表示を「現在進行中のフロー」に絞る）。
MAX_AGE_SECONDS=604800
NOW_EPOCH=""

usage() {
  echo "Usage: $0 [--log-file PATH] [--stale-seconds N] [--max-age-seconds N] [--now-epoch N]" >&2
  echo "  --stale-seconds N    この秒数を超えて更新がないrunning/waiting/starting中のエージェントを「止まってる？」と表示する（既定: 180）" >&2
  echo "  --max-age-seconds N  最終報告がこの秒数より古いエージェントは表示しない（既定: 604800＝7日。0 で無制限）" >&2
  echo "  --now-epoch N        現在時刻をUNIX epoch秒で上書きする（主にテスト用）" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --stale-seconds) STALE_SECONDS="$2"; shift 2 ;;
    --max-age-seconds) MAX_AGE_SECONDS="$2"; shift 2 ;;
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

jq -s -r --argjson now "$NOW_EPOCH" --argjson stale "$STALE_SECONDS" --argjson maxAge "$MAX_AGE_SECONDS" '
  def epoch: (. | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime);
  def render:
    . as $e
    | ($e.timestamp | epoch) as $t
    | ($now - $t) as $ageSec
    | if ($e.status != "done" and $e.status != "failed" and $ageSec > $stale)
      then "\($e.agent)：止まってる？（\($ageSec)秒応答なし）"
      elif $e.status == "done" then "\($e.agent)：\($e.note) ✓"
      elif $e.status == "failed" then "\($e.agent)：\($e.note) ✗"
      else "\($e.agent)：\($e.note)"
      end;
  group_by(.agent)
  | map(sort_by(.timestamp) | .[-1])
  | sort_by(.agent)
  | map(select($maxAge == 0 or ($now - (.timestamp | epoch)) <= $maxAge)) as $recent
  | (length - ($recent | length)) as $hidden
  | ($recent | map(render))
    + (if $hidden > 0
       then ["（他 \($hidden) 件は最終報告が \($maxAge) 秒（\($maxAge / 86400 | floor) 日）より前のため非表示。--max-age-seconds 0 で全件表示）"]
       else [] end)
  | .[]
' "$LOG_FILE"
