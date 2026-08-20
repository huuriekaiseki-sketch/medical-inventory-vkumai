#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなっていた（issue #636）。
# ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

# WHY: issue #488。gap check（記録漏れ検知）の実行はこれまで人起動の4ステップ手順で
# 「checkし忘れたら気づけない」第3層ルールだった。このスクリプトはStop hookとして毎ターン
# 終了時に発火し、record-gap-check-state.sh が書いた .aidd/gap-check-state.json を読んで、
# expected件数が記録済みなら check-loop-observability-gap.sh / check-agent-progress-gap.sh を
# 自動実行する（起動トリガーの機械化、issue #411原則）。
#
# - hasGap時はsystemMessageで警告する（Stop hookはblock不可の運用のためwarningのみ）
# - 実行後はgap有無にかかわらずstateファイルを削除する（1フロー実行=1回のcheck）
# - stateファイルが無いセッション（AIDDフロー非実行）では完全に沈黙する
# - expected未記録のままGAP_CHECK_STALE_SECONDS（既定24時間）を超えたstateファイルは
#   中断フローの残骸とみなして削除する。その際も「gap check未実施のまま破棄した」旨を
#   systemMessageで警告する（停止①レビュー指摘の反映: 「中断しただけ」と「漏れを見逃して
#   消えた」を事後に区別できるようにするため）
#
# 既知の限界:
# - stateファイルへの記録自体はオーケストレーターの自己申告のまま
#   （Workflow DSLがfilesystem API不可のため）。「書いたのにcheckし忘れる」は本hookで
#   構造的に消えるが、「そもそも書き忘れる」は残る（issue #488本文に明記済み）
# - 同一worktreeで複数のClaude Codeセッションが同時にAIDDフローを走らせた場合、
#   stateファイルは共有されるため他セッションの値が混入しうる（排他制御なし）。
#   worktreeを分ける運用（既定）では発生せず、影響もwarningの精度低下のみのため許容する
#
# 環境変数（テスト用の注入ポイント）:
#   GAP_CHECK_STATE_FILE     stateファイルパス（既定 .aidd/gap-check-state.json）
#   GAP_CHECK_LOOP_CMD       loop-observability用gap checkコマンド
#   GAP_CHECK_PROGRESS_CMD   agent-progress用gap checkコマンド
#   GAP_CHECK_STALE_SECONDS  残骸判定の閾値秒（既定86400）
#   GAP_CHECK_NOW_EPOCH      現在時刻epoch秒の上書き

cd "$(dirname "$0")/.."

STATE_FILE="${GAP_CHECK_STATE_FILE:-.aidd/gap-check-state.json}"
LOOP_GAP_CMD="${GAP_CHECK_LOOP_CMD:-scripts/check-loop-observability-gap.sh}"
PROGRESS_GAP_CMD="${GAP_CHECK_PROGRESS_CMD:-scripts/check-agent-progress-gap.sh}"
STALE_SECONDS="${GAP_CHECK_STALE_SECONDS:-86400}"
NOW="${GAP_CHECK_NOW_EPOCH:-$(date +%s)}"

emit() {
  jq -n --arg msg "$1" '{systemMessage: $msg}'
}

if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

# jqが無い環境では読み取りも警告出力もできないため沈黙する（stateファイルは残し、
# jqのある環境での次回発火に委ねる。emit()だけがjq不在で異常終了する非対称を避ける）
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

BEFORE_LOOP="$(jq -r '.beforeLoopObservability // empty' "$STATE_FILE" 2>/dev/null || true)"
BEFORE_PROGRESS="$(jq -r '.beforeAgentProgress // empty' "$STATE_FILE" 2>/dev/null || true)"
EXPECTED_LOOP="$(jq -r '.expectedLoopObservability // empty' "$STATE_FILE" 2>/dev/null || true)"
EXPECTED_PROGRESS="$(jq -r '.expectedAgentProgress // empty' "$STATE_FILE" 2>/dev/null || true)"
RECORDED_AT="$(jq -r '.recordedAt // empty' "$STATE_FILE" 2>/dev/null || true)"

# recordedAtが非数値（JSONとしては正当だが破損しているstate）の場合、set -u下の算術評価で
# クラッシュしstateが残り続ける（毎ターン再クラッシュ）ため、空扱いに正規化して
# 「破棄＋警告」の分岐に倒す
case "$RECORDED_AT" in
  ''|*[!0-9]*) RECORDED_AT="" ;;
esac

if [ -z "$EXPECTED_LOOP" ] && [ -z "$EXPECTED_PROGRESS" ]; then
  if [ -n "$RECORDED_AT" ] && [ $((NOW - RECORDED_AT)) -le "$STALE_SECONDS" ]; then
    # before記録済み・expected未記録はフロー実行中とみなし、何もしない（クリアもしない）
    exit 0
  fi
  # 中断フローの残骸またはstate破損。削除するが、破棄自体は観測可能にする（停止①レビュー指摘）
  rm -f "$STATE_FILE"
  emit "AIDDフローのgap check state（${STATE_FILE}）を破棄しました（expected未記録のまま閾値${STALE_SECONDS}秒を超過、またはstateファイル破損）。このフローのgap check（記録漏れ検知）は未実施です。フローが中断されていた場合、必要に応じて scripts/check-loop-observability-gap.sh / scripts/check-agent-progress-gap.sh を手動実行してください（issue #488）。"
  exit 0
fi

GAP_WARNINGS=""
EXEC_FAILURES=""

run_check() {
  local cmd="$1" before="$2" expected="$3" label="$4"
  local out code
  set +e
  out="$(bash "$cmd" --before "$before" --expected "$expected" 2>&1)"
  code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    return 0
  fi
  # 本物のgap（出力に hasGap:true がある）と、npx/jq等の実行基盤エラー（gap有無を判定
  # できていない）を区別する。同一文言に丸めると原因調査の初手を誤らせるため（レビュー指摘）
  if printf '%s' "$out" | grep -qF '"hasGap":true'; then
    GAP_WARNINGS="${GAP_WARNINGS}
- ${label}: ${out}"
  else
    EXEC_FAILURES="${EXEC_FAILURES}
- ${label}: ${out}"
  fi
}

if [ -n "$EXPECTED_LOOP" ] && [ -n "$BEFORE_LOOP" ]; then
  run_check "$LOOP_GAP_CMD" "$BEFORE_LOOP" "$EXPECTED_LOOP" "loop-observability"
fi
if [ -n "$EXPECTED_PROGRESS" ] && [ -n "$BEFORE_PROGRESS" ]; then
  run_check "$PROGRESS_GAP_CMD" "$BEFORE_PROGRESS" "$EXPECTED_PROGRESS" "agent-progress"
fi

rm -f "$STATE_FILE"

MSG=""
if [ -n "$GAP_WARNINGS" ]; then
  MSG="AIDDフローの観測ログに記録漏れ（またはズレ）の可能性があります（Stop hookによる自動gap check、issue #488）。issue化するか原因を調査してください（docs/agents/common.md「loop-observabilityログの記録漏れ検知」参照）:${GAP_WARNINGS}"
  # issue #523: 検知して終わりにせず、次回SessionStart時に確実に思い出せるようキューへ
  # 登録する（scripts/check-recovery-queue.sh参照）。失敗してもこのhook自体の警告出力は
  # 継続する（fail-open。キュー登録はベストエフォート）
  bash scripts/queue-recovery-task.sh --type "gap-check-followup" \
    --detail "$(jq -n --arg warnings "$GAP_WARNINGS" '{gapWarnings: $warnings}')" \
    >/dev/null 2>&1 || true
fi
if [ -n "$EXEC_FAILURES" ]; then
  if [ -n "$MSG" ]; then
    MSG="${MSG}

"
  fi
  MSG="${MSG}以下のgap checkは実行自体に失敗しました（npx/jq等の実行環境要因の可能性。記録漏れの有無は未判定です）:${EXEC_FAILURES}"
fi
if [ -n "$MSG" ]; then
  emit "$MSG"
fi

exit 0
