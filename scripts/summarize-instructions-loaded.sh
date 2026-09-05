#!/usr/bin/env bash
set -euo pipefail

# logs/instructions-loaded.jsonl（InstructionsLoaded hook の記録、issue #742）を集計する。
#
# 出力 2 節:
#   1. 直近セッションの session_start ロード量（ファイル別の文字数と合計）。
#      check-claude-md-size.sh の自前計算（CLAUDE.md + @import + paths 無し rules）と
#      同じ単位（文字数）で出すので、両者の差＝自前計算側の穴として読める
#   2. 期間内のファイル別ロード回数（loadReason 別）。path_glob_match / include で
#      一度も読まれない rules は「削除候補」として月次で眺める材料にする
#
# 集計ロジックは jq に寄せ、シェル側は引数処理のみ。`|` を含む jq フィルタは
# Bash ガードに誤検知されるため lib/summarize-instructions-loaded.jq に分離している。
#
# 使い方:
#   bash scripts/summarize-instructions-loaded.sh [--log-file PATH] [--days N]
#   --days の既定は 30（月次サマリの期間に合わせる）

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/instructions-loaded.jsonl"
DAYS=30
while [ $# -gt 0 ]; do
  case "$1" in
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --days) DAYS="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "jq が必要です" >&2; exit 1; }
if [ ! -f "$LOG_FILE" ]; then
  echo "記録なし（$LOG_FILE が無い。InstructionsLoaded hook が一度も発火していないか、Claude Code の版が古い）"
  exit 0
fi

# 期間の下限（UTC ISO8601）。BSD date と GNU date の両方で動く形にする
if date -u -v-1d +%Y >/dev/null 2>&1; then
  SINCE="$(date -u -v-"${DAYS}"d +"%Y-%m-%dT%H:%M:%SZ")"
else
  SINCE="$(date -u -d "-${DAYS} days" +"%Y-%m-%dT%H:%M:%SZ")"
fi

jq -r -s --arg since "$SINCE" --arg days "$DAYS" -f "$SCRIPT_DIR/lib/summarize-instructions-loaded.jq" "$LOG_FILE"
