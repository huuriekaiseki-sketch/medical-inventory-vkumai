#!/usr/bin/env bash
set -euo pipefail

# WHY: issue #522（issue #432の後続）。品質ゲートの許容誤判定率（precision/recall閾値）を
# 数値で確定させる作業に着手する前に、baselineデータを実際に集計したところ、
# `logs/find-av-precision.jsonl`（Find→Adversarial Verify生存率。issue #432で仕組みは
# 作られていた）への記録が一度も残っていないことが判明した。原因は、この記録が
# `scripts/log-find-av-precision.sh`という「Workflow DSLがfilesystem API不可のため、
# フロー完了後にオーケストレーター（Claude Code）が戻り値を渡して呼ぶ」人/エージェント起動の
# 第3層ルールであり、呼び忘れを機械的に検知する手段が無かったため（issue #411原則に照らし、
# issue #432起票時は機械検知まで実装していなかった）。
# 数値で閾値を決めるには実データの蓄積が先決のため、まずこの記録漏れをStop hookで検知する
# （check-aidd-phase-stats-recorded.sh、issue #524と同型のパターン）。
#
# 検知ロジック:
# 1. Workflowツールがラン毎に生成する <transcript配置ディレクトリ>/<session_id>/workflows/
#    wf_*.json（issue #524調査で判明した構造）を走査し、aidd-1-1-deep-taskの`.result`に
#    `findAvPrecision.verifiedCount`が1以上の値で存在するランがあるかを確認する
#    （verifiedCount=0＝そもそも検証対象が無かった回は記録すべきデータが無いため対象外）
# 2. あれば、logs/find-av-precision.jsonl の最新エントリのtimestampがセッション開始以降か
#    どうかを確認する
# 3. 記録が無い、またはセッション開始より古ければ警告する
#
# 設計方針:
# - fail-open: 判定材料が取れないケースはすべて沈黙する
# - 警告は同一セッションにつき1回のみ
# - 全経路 exit 0（blockしない）
# - check-aidd-phase-stats-recorded.sh・check-aidd-stats-recorded.shとは独立したスクリプト・
#   独立したhook登録として追加する（既存スクリプトへ手を入れるリスクを避けるため）
#
# 環境変数（テスト用の注入ポイント）:
#   FIND_AV_PRECISION_CHECK_SESSION_ID       hook stdinのsession_idの代替
#   FIND_AV_PRECISION_CHECK_TRANSCRIPT_PATH  hook stdinのtranscript_pathの代替
#   FIND_AV_PRECISION_CHECK_WORKFLOWS_DIR    workflows記録ディレクトリの代替
#   FIND_AV_PRECISION_CHECK_LOG_FILE         find-av-precisionログの代替（既定 logs/find-av-precision.jsonl）
#   FIND_AV_PRECISION_CHECK_MARKER_FILE      警告済みマーカー（既定 .aidd/find-av-precision-warning-shown.json）

cd "$(dirname "$0")/.."

command -v jq >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

LOG_FILE="${FIND_AV_PRECISION_CHECK_LOG_FILE:-logs/find-av-precision.jsonl}"
MARKER_FILE="${FIND_AV_PRECISION_CHECK_MARKER_FILE:-.aidd/find-av-precision-warning-shown.json}"

HOOK_INPUT=""
if [ -z "${FIND_AV_PRECISION_CHECK_SESSION_ID:-}" ] || [ -z "${FIND_AV_PRECISION_CHECK_TRANSCRIPT_PATH:-}" ]; then
  HOOK_INPUT="$(cat 2>/dev/null || true)"
fi
SESSION_ID="${FIND_AV_PRECISION_CHECK_SESSION_ID:-$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)}"
TRANSCRIPT_PATH="${FIND_AV_PRECISION_CHECK_TRANSCRIPT_PATH:-$(printf '%s' "$HOOK_INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || true)}"

[ -n "$SESSION_ID" ] || exit 0

# 警告済みマーカー: 同一セッションでは2回目以降沈黙
if [ -f "$MARKER_FILE" ]; then
  WARNED_SESSION="$(jq -r '.sessionId // empty' "$MARKER_FILE" 2>/dev/null || true)"
  if [ "$WARNED_SESSION" = "$SESSION_ID" ]; then
    exit 0
  fi
fi

# 1. workflows実行記録ディレクトリを特定
if [ -n "${FIND_AV_PRECISION_CHECK_WORKFLOWS_DIR:-}" ]; then
  WORKFLOWS_DIR="$FIND_AV_PRECISION_CHECK_WORKFLOWS_DIR"
else
  [ -n "$TRANSCRIPT_PATH" ] || exit 0
  PROJECT_DIR="$(dirname "$TRANSCRIPT_PATH")"
  WORKFLOWS_DIR="$PROJECT_DIR/$SESSION_ID/workflows"
fi
[ -d "$WORKFLOWS_DIR" ] || exit 0

HAS_VERIFIED_DATA=0
shopt -s nullglob
for wf_file in "$WORKFLOWS_DIR"/wf_*.json; do
  [ -f "$wf_file" ] || continue
  VERIFIED_COUNT="$(jq -r '[.. | objects | select(has("findAvPrecision")) | .findAvPrecision.verifiedCount] | max // 0' "$wf_file" 2>/dev/null || echo 0)"
  case "$VERIFIED_COUNT" in
    ''|*[!0-9]*) VERIFIED_COUNT=0 ;;
  esac
  if [ "$VERIFIED_COUNT" -gt 0 ]; then
    HAS_VERIFIED_DATA=1
  fi
done
shopt -u nullglob

[ "$HAS_VERIFIED_DATA" -eq 1 ] || exit 0

# 2. セッション開始時刻（transcript先頭行timestamp。末尾ZのUTC表記のみ信頼する）
SESSION_START_EPOCH=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  FIRST_TS="$(head -1 "$TRANSCRIPT_PATH" 2>/dev/null | jq -r '.timestamp // empty' 2>/dev/null || true)"
  case "$FIRST_TS" in
    *Z)
      SESSION_START_EPOCH="$(python3 -c "
import sys, datetime
try:
    ts = sys.argv[1][:19]
    dt = datetime.datetime.strptime(ts, '%Y-%m-%dT%H:%M:%S').replace(tzinfo=datetime.timezone.utc)
    print(int(dt.timestamp()))
except Exception:
    pass
" "$FIRST_TS" 2>/dev/null || true)"
      ;;
  esac
fi
[ -n "$SESSION_START_EPOCH" ] || exit 0

# 3. logs/find-av-precision.jsonlの最新エントリがセッション開始以降か
RECORDED=0
if [ -f "$LOG_FILE" ]; then
  LAST_TS="$(tail -n 50 "$LOG_FILE" 2>/dev/null | jq -R -r 'fromjson? | .timestamp // empty' 2>/dev/null | tail -n 1 || true)"
  case "$LAST_TS" in
    *Z)
      LAST_EPOCH="$(python3 -c "
import sys, datetime
try:
    ts = sys.argv[1][:19]
    dt = datetime.datetime.strptime(ts, '%Y-%m-%dT%H:%M:%S').replace(tzinfo=datetime.timezone.utc)
    print(int(dt.timestamp()))
except Exception:
    pass
" "$LAST_TS" 2>/dev/null || true)"
      if [ -n "${LAST_EPOCH:-}" ] && [ "$LAST_EPOCH" -ge $((SESSION_START_EPOCH - 60)) ]; then
        RECORDED=1
      fi
      ;;
  esac
fi

[ "$RECORDED" -eq 0 ] || exit 0

write_marker() {
  local dir tmp
  dir="$(dirname "$MARKER_FILE")"
  mkdir -p "$dir" 2>/dev/null || return 1
  tmp="$(mktemp "$dir/.find-av-precision-warning.XXXXXX" 2>/dev/null)" || return 1
  jq -n --arg sid "$SESSION_ID" '{sessionId: $sid}' > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$MARKER_FILE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  return 0
}
set +e
write_marker
set -e

MSG="このセッションはaidd-1-1-deep-taskでFind→Adversarial Verifyの検証（findAvPrecision）を実行した形跡がありますが、logs/find-av-precision.jsonlへの記録（scripts/log-find-av-precision.sh）が見当たりません（issue #522）。品質ゲートの許容誤判定率を決めるにはこのデータの蓄積が前提のため、今からでも記録してください（この警告はセッションにつき1回のみ表示されます）。"
jq -n --arg msg "$MSG" '{systemMessage: $msg}'

exit 0
