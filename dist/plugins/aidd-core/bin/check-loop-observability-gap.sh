#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../scripts/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/loop-observability.jsonl"
BEFORE_COUNT=""
EXPECTED_COUNT=""

usage() {
  echo "Usage: $0 --before N --expected M [--log-file PATH]" >&2
  echo "  --before N    フロー実行前に計測した logs/loop-observability.jsonl の行数" >&2
  echo "  --expected M  ワークフローの戻り値 expectedLoopObservabilityRecords" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --before) BEFORE_COUNT="$2"; shift 2 ;;
    --expected) EXPECTED_COUNT="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

if [[ -z "$BEFORE_COUNT" || -z "$EXPECTED_COUNT" ]]; then
  usage
fi

# WHY(issue #812): 総行数ではなく「フローの記録」だけを数える（E2E の reporter も同じログに書く）。
# before 側（record-gap-check-state.sh）と同じ関数を使う。別々に数えると差が合わない
source "$SCRIPT_DIR/../scripts/lib/count-flow-loop-records.sh"
AFTER_COUNT="$(count_flow_loop_records "$LOG_FILE")"

ACTUAL_COUNT=$(( AFTER_COUNT - BEFORE_COUNT ))

# WHY: npx tsx はレジストリ依存で遅い日に数分かかる（harvest-journal-events.sh のコメント参照）。
#      実体は .js（ESM）なので node で直接実行する
#
# WHY(issue #806、出力が空なら「漏れなし」と読まない): 判定は結果を必ず標準出力へ 1 行言う設計。何も言わずに
# exit 0 で終わったなら、判定は**走っていない**（2026-09-19 に実際に起きた——symlink を含むパスで起動すると
# main() が呼ばれず無出力で終わっていた）。「何も起きなかった」を合格に数えると、記録漏れがあっても黙って緑になる。
# 合格にも違反にも数えず、確かめられなかったと言って非 0 で終える。Stop hook（check-gap-check-state.sh）は
# 「非 0 かつ判定の出力が無い」を実行失敗・未判定として扱うので、ここでは判定の JSON を出さない
set +e
JUDGE_OUT="$(node --experimental-detect-module --no-warnings "$SCRIPT_DIR/../scripts/workflow-lib/loop-observability-gap.js" --actual "$ACTUAL_COUNT" --expected "$EXPECTED_COUNT")"
JUDGE_EXIT=$?
set -e
if [ -z "$JUDGE_OUT" ]; then
  echo "ERROR: loop-observability の gap 判定が何も出力しませんでした（exit=${JUDGE_EXIT}）。記録漏れの有無は確かめられていません（「漏れなし」ではありません）" >&2
  exit 2
fi
printf '%s\n' "$JUDGE_OUT"
exit "$JUDGE_EXIT"
