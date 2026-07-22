#!/usr/bin/env bash
set -euo pipefail

# WHY: AIDDフローのgap check（check-loop-observability-gap.sh / check-agent-progress-gap.sh）は
# これまで「実行前にwc -l/jqで件数を控え、フロー完了後に手動実行する」4ステップの人起動手順
# だった（docs/agents/common.md、第3層ルール）。issue #488で、控える値を
# .aidd/gap-check-state.json に永続化し、check実行自体はStop hook
# （scripts/check-gap-check-state.sh）が機械トリガーする方式に変更した。
# このスクリプトはその記録側で、件数の計測自体もスクリプトが行う（手動計測の控え間違いを排除）。
#
# 【重要】オーケストレーター（Claude本体）専用。サブエージェント・Workflow内から呼ばないこと。
# Workflow DSLはfilesystem API不可のため構造的に呼べず、サブエージェントへの記録指示にも
# 含めない設計。オーケストレーターのBash実行は逐次のためread-modify-write競合は発生しない
# 前提（保険として書き込みは一時ファイル→mvのatomic方式にしている。ロックは導入しない）。
# 同一worktreeで複数セッションが並行してAIDDフローを走らせるケースは未防御（既知の限界。
# worktreeを分ける運用が既定のため許容。詳細はcheck-gap-check-state.shのヘッダ参照）。
#
# Usage:
#   scripts/record-gap-check-state.sh before
#     現在のログ件数を計測してbefore値として記録する。
#     既にbefore値が記録済みの場合は上書きしない（first-write-wins。1フロー実行の起点を固定する）。
#   scripts/record-gap-check-state.sh expected [--loop-observability N] [--agent-progress M]
#     Workflow戻り値のexpected件数を加算記録する（最低どちらか1つ必須）。
#     phase1のexpectedAgentProgressRecordsとphase2の同値を合算できるよう加算方式。
#     before未記録の場合は手順逸脱としてexit 1。
#
# 環境変数（テスト用の注入ポイント）:
#   GAP_CHECK_STATE_FILE   stateファイルパス（既定 .aidd/gap-check-state.json）
#   GAP_CHECK_LOOP_LOG     loop-observabilityログ（既定 logs/loop-observability.jsonl）
#   GAP_CHECK_PROGRESS_LOG agent-progressログ（既定 logs/agent-progress.jsonl）
#   GAP_CHECK_NOW_EPOCH    現在時刻epoch秒の上書き

cd "$(dirname "$0")/.."

STATE_FILE="${GAP_CHECK_STATE_FILE:-.aidd/gap-check-state.json}"
LOOP_LOG="${GAP_CHECK_LOOP_LOG:-logs/loop-observability.jsonl}"
PROGRESS_LOG="${GAP_CHECK_PROGRESS_LOG:-logs/agent-progress.jsonl}"

usage() {
  echo "Usage: $0 before" >&2
  echo "       $0 expected [--loop-observability N] [--agent-progress M]" >&2
  exit 1
}

write_state() {
  local json="$1"
  local dir tmp
  dir="$(dirname "$STATE_FILE")"
  mkdir -p "$dir"
  tmp="$(mktemp "$dir/.gap-check-state.XXXXXX")"
  printf '%s\n' "$json" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

has_before() {
  [ -f "$STATE_FILE" ] && jq -e '.beforeLoopObservability != null' "$STATE_FILE" >/dev/null 2>&1
}

count_loop_lines() {
  if [ -f "$LOOP_LOG" ]; then
    wc -l < "$LOOP_LOG" | tr -d ' '
  else
    echo 0
  fi
}

# done/failed件数の判定はcommon.mdの手動手順（jqコマンド）と同一
count_progress_done_failed() {
  if [ -f "$PROGRESS_LOG" ]; then
    jq -s '[.[] | select(.status == "done" or .status == "failed")] | length' "$PROGRESS_LOG"
  else
    echo 0
  fi
}

SUBCOMMAND="${1:-}"
case "$SUBCOMMAND" in
  before)
    if has_before; then
      echo "[gap-check-state] before値は記録済みのため上書きしません（first-write-wins）: $STATE_FILE"
      exit 0
    fi
    BEFORE_LOOP="$(count_loop_lines)"
    BEFORE_PROGRESS="$(count_progress_done_failed)"
    NOW="${GAP_CHECK_NOW_EPOCH:-$(date +%s)}"
    JSON="$(jq -n --argjson bl "$BEFORE_LOOP" --argjson bp "$BEFORE_PROGRESS" --argjson at "$NOW" \
      '{beforeLoopObservability: $bl, beforeAgentProgress: $bp, recordedAt: $at}')"
    write_state "$JSON"
    echo "[gap-check-state] before値を記録しました (loopObservability=$BEFORE_LOOP, agentProgress=$BEFORE_PROGRESS)"
    ;;
  expected)
    shift
    ADD_LOOP=""
    ADD_PROGRESS=""
    LOOP_SET=""
    PROGRESS_SET=""
    # ${2:-}と2段shiftにしているのは、値の渡し忘れ（例: expected --agent-progress で終わる
    # 呼び出し）をset -u下の生のunbound variableクラッシュではなくusage/検証エラーに
    # 倒すため（レビュー指摘）
    while [ $# -gt 0 ]; do
      case "$1" in
        --loop-observability) ADD_LOOP="${2:-}"; LOOP_SET=1; shift; shift || true ;;
        --agent-progress) ADD_PROGRESS="${2:-}"; PROGRESS_SET=1; shift; shift || true ;;
        *) echo "Unknown argument: $1" >&2; usage ;;
      esac
    done
    if [ -z "$LOOP_SET" ] && [ -z "$PROGRESS_SET" ]; then
      usage
    fi
    is_nonneg_int() {
      case "$1" in
        ''|*[!0-9]*) return 1 ;;
        *) return 0 ;;
      esac
    }
    if [ -n "$LOOP_SET" ] && ! is_nonneg_int "$ADD_LOOP"; then
      echo "ERROR: --loop-observability の値が不正です（非負整数が必要）: '$ADD_LOOP'" >&2
      exit 1
    fi
    if [ -n "$PROGRESS_SET" ] && ! is_nonneg_int "$ADD_PROGRESS"; then
      echo "ERROR: --agent-progress の値が不正です（非負整数が必要）: '$ADD_PROGRESS'" >&2
      exit 1
    fi
    if ! has_before; then
      echo "ERROR: before値が未記録です。フロー開始時に '$0 before' を先に実行してください" >&2
      exit 1
    fi
    JSON="$(cat "$STATE_FILE")"
    # 指定された項目だけを加算する（未指定の項目はフィールド自体を作らない。
    # 0で実体化するとStop hook側が「expected 0のcheck」を余計に実行してしまうため）
    if [ -n "$LOOP_SET" ]; then
      JSON="$(printf '%s' "$JSON" | jq --argjson n "$ADD_LOOP" '.expectedLoopObservability = ((.expectedLoopObservability // 0) + $n)')"
    fi
    if [ -n "$PROGRESS_SET" ]; then
      JSON="$(printf '%s' "$JSON" | jq --argjson n "$ADD_PROGRESS" '.expectedAgentProgress = ((.expectedAgentProgress // 0) + $n)')"
    fi
    write_state "$JSON"
    echo "[gap-check-state] expected値を加算しました (+loopObservability=${ADD_LOOP:-0}, +agentProgress=${ADD_PROGRESS:-0})"
    ;;
  *)
    usage
    ;;
esac
