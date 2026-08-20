#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなっていた（issue #636）。
# ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

# WHY: issue #524（issue #495の後続。#444「hook拡張第2弾」と同型のhook拡張第3弾）。
# ~/write_aidd_stats.sh の呼び忘れのうち、「セッション全体のstart呼び忘れ」は
# check-aidd-stats-recorded.sh（issue #495）が検知済みだが、「phase単位（phase1/phase2）の
# 呼び忘れ」はdocs/agents/common.md「検知手段のないルールの棚卸し」表の第3層ルールとして
# 残っていた。
# このスクリプトはStop hookとして毎ターン終了時に発火し、このセッションで
# aidd-phase1系（aidd-phase1 / aidd-1-1-deep-task / aidd-phase1-router経由での委譲）または
# aidd-phase2 のWorkflow実行の形跡があるのに、対応するphase1/phase2のstats記録
# （~/write_aidd_stats.sh phase1/phase2）が無い場合にsystemMessageで警告する
# （block不可・warningのみ）。
#
# 検知ロジック:
# 1. Workflowツールはラン毎に <transcript配置ディレクトリ>/<session_id>/workflows/wf_*.json
#    という実行記録ファイルを生成する（issue #524調査で判明。SubagentStart/Stop hookの
#    共有skeletonログ[logs/subagent-skeleton.jsonl、issue #423]とは別の、セッション固有の
#    ファイル）。このディレクトリ配下の全wf_*.jsonを走査する
# 2. 各ファイルの`.result`フィールド（Workflowの実際の返却値。ソースコード文字列である
#    `.script`フィールドは意図的に除外し誤検知を避ける）を再帰的に走査し、
#    "phase1"で始まる文字列値（phase1 / phase1-meta / phase1-needs-confirmation。
#    aidd-phase1.js・aidd-phase1-router.jsのstats.phase）と、"phase2"に完全一致する
#    文字列値（aidd-phase2.jsのstats.phase）の有無を判定する
#    （route自体の判定[deep/light/meta/confirm]に関わらず、Phase1調査の入り口を通過した
#    形跡があれば「phase1相当の作業をした」とみなす近似判定でよい。confirmルート等での
#    過検知は許容する。issue本文の方針どおり）
# 3. phase1形跡があるのに、statsファイルのphase1_end_atがセッション開始以降で記録されて
#    いなければ警告対象に加える（phase2/phase2_end_atも同様）
#
# 設計方針:
# - fail-open: 判定材料が取れないケース（jq/python3不在・ディレクトリ不在等）はすべて沈黙する
# - 警告は同一セッションにつき1回のみ（phase1/phase2をまとめて1つのマーカーで抑止）
# - 全経路 exit 0（blockしない）
# - check-aidd-stats-recorded.sh（issue #495）本体は改修せず、独立したスクリプト・
#   独立したhook登録として追加する（既存の複雑なfail-open分岐へ手を入れるリスクを避けるため）
#
# 既知の限界:
# - 「Workflow実行の形跡」の判定はwf_*.json内の文字列走査による近似判定であり、
#   route='confirm'（実際には調査に着手していない）でもphase1形跡ありと扱われうる
# - agentType不明のresultフィールド構造が将来変わった場合、この文字列走査は追従しない
#   （sync testの対象外。プロンプト文字列ではなくWorkflowツールの実行記録フォーマットに
#   依存するため）
#
# 環境変数（テスト用の注入ポイント）:
#   AIDD_PHASE_STATS_CHECK_SESSION_ID       hook stdinのsession_idの代替
#   AIDD_PHASE_STATS_CHECK_TRANSCRIPT_PATH  hook stdinのtranscript_pathの代替
#   AIDD_PHASE_STATS_CHECK_WORKFLOWS_DIR    workflows記録ディレクトリの代替
#   AIDD_PHASE_STATS_CHECK_STATS_DIR        statsディレクトリ（既定 ~/.claude/aidd-session-stats）
#   AIDD_PHASE_STATS_CHECK_MARKER_FILE      警告済みマーカー（既定 .aidd/aidd-phase-stats-warning-shown.json）

cd "$(dirname "$0")/.."

command -v jq >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

MARKER_FILE="${AIDD_PHASE_STATS_CHECK_MARKER_FILE:-.aidd/aidd-phase-stats-warning-shown.json}"

if [ -n "${AIDD_PHASE_STATS_CHECK_STATS_DIR:-}" ]; then
  STATS_DIR="$AIDD_PHASE_STATS_CHECK_STATS_DIR"
elif [ -n "${HOME:-}" ]; then
  STATS_DIR="$HOME/.claude/aidd-session-stats"
else
  exit 0
fi

HOOK_INPUT=""
if [ -z "${AIDD_PHASE_STATS_CHECK_SESSION_ID:-}" ] || [ -z "${AIDD_PHASE_STATS_CHECK_TRANSCRIPT_PATH:-}" ]; then
  HOOK_INPUT="$(cat 2>/dev/null || true)"
fi
SESSION_ID="${AIDD_PHASE_STATS_CHECK_SESSION_ID:-$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)}"
TRANSCRIPT_PATH="${AIDD_PHASE_STATS_CHECK_TRANSCRIPT_PATH:-$(printf '%s' "$HOOK_INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || true)}"

[ -n "$SESSION_ID" ] || exit 0

# 警告済みマーカー: 同一セッションでは2回目以降沈黙
if [ -f "$MARKER_FILE" ]; then
  WARNED_SESSION="$(jq -r '.sessionId // empty' "$MARKER_FILE" 2>/dev/null || true)"
  if [ "$WARNED_SESSION" = "$SESSION_ID" ]; then
    exit 0
  fi
fi

# 1. workflows実行記録ディレクトリを特定
if [ -n "${AIDD_PHASE_STATS_CHECK_WORKFLOWS_DIR:-}" ]; then
  WORKFLOWS_DIR="$AIDD_PHASE_STATS_CHECK_WORKFLOWS_DIR"
else
  [ -n "$TRANSCRIPT_PATH" ] || exit 0
  PROJECT_DIR="$(dirname "$TRANSCRIPT_PATH")"
  WORKFLOWS_DIR="$PROJECT_DIR/$SESSION_ID/workflows"
fi
[ -d "$WORKFLOWS_DIR" ] || exit 0

PHASE1_SEEN=0
PHASE2_SEEN=0
shopt -s nullglob
for wf_file in "$WORKFLOWS_DIR"/wf_*.json; do
  [ -f "$wf_file" ] || continue
  MATCHES="$(jq -r '[.result | .. | strings] | .[]' "$wf_file" 2>/dev/null || true)"
  if printf '%s\n' "$MATCHES" | grep -q '^phase1'; then
    PHASE1_SEEN=1
  fi
  if printf '%s\n' "$MATCHES" | grep -q '^phase2$'; then
    PHASE2_SEEN=1
  fi
done
shopt -u nullglob

if [ "$PHASE1_SEEN" -eq 0 ] && [ "$PHASE2_SEEN" -eq 0 ]; then
  exit 0
fi

# 2. セッション開始時刻（transcript先頭行timestamp。末尾ZのUTC表記のみ信頼する。
# check-aidd-stats-recorded.shと同一パターン）
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

# 3. statsファイル（write_aidd_stats.shと同一のcwdハッシュキー）のphase1_end_at/phase2_end_at
STATS_KEY="$(python3 -c 'import hashlib, os; print(hashlib.sha256(os.getcwd().encode()).hexdigest()[:16])' 2>/dev/null || true)"
[ -n "$STATS_KEY" ] || exit 0
STATS_FILE="$STATS_DIR/$STATS_KEY.json"

get_recorded_at() {
  local key="$1"
  local val=""
  if [ -f "$STATS_FILE" ]; then
    val="$(jq -r --arg k "$key" '.[$k] // empty' "$STATS_FILE" 2>/dev/null || true)"
  fi
  case "$val" in
    *[!0-9]*) val="" ;;
  esac
  printf '%s' "$val"
}

PHASE1_RECORDED=0
if [ "$PHASE1_SEEN" -eq 1 ]; then
  AT="$(get_recorded_at phase1_end_at)"
  if [ -n "$AT" ] && [ "$AT" -ge $((SESSION_START_EPOCH - 60)) ]; then
    PHASE1_RECORDED=1
  fi
fi

PHASE2_RECORDED=0
if [ "$PHASE2_SEEN" -eq 1 ]; then
  AT="$(get_recorded_at phase2_end_at)"
  if [ -n "$AT" ] && [ "$AT" -ge $((SESSION_START_EPOCH - 60)) ]; then
    PHASE2_RECORDED=1
  fi
fi

MISSING=""
if [ "$PHASE1_SEEN" -eq 1 ] && [ "$PHASE1_RECORDED" -eq 0 ]; then
  MISSING="${MISSING}phase1 "
fi
if [ "$PHASE2_SEEN" -eq 1 ] && [ "$PHASE2_RECORDED" -eq 0 ]; then
  MISSING="${MISSING}phase2"
fi

[ -n "$MISSING" ] || exit 0

# マーカー書き込み失敗時もクラッシュせず警告は出す
# （check-aidd-stats-recorded.shと同一パターン。Stop hookの「全経路exit 0」が絶対要件）
write_marker() {
  local dir tmp
  dir="$(dirname "$MARKER_FILE")"
  mkdir -p "$dir" 2>/dev/null || return 1
  tmp="$(mktemp "$dir/.aidd-phase-stats-warning.XXXXXX" 2>/dev/null)" || return 1
  jq -n --arg sid "$SESSION_ID" '{sessionId: $sid}' > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$MARKER_FILE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  return 0
}
set +e
write_marker
set -e

MSG="このセッションはaidd-phase1系/aidd-phase2のWorkflow実行の形跡がありますが、対応するphase単位のAIDD stats記録（~/write_aidd_stats.sh ${MISSING}）が見当たりません（issue #524）。CLAUDE.md「AIDD stats 書き出しルール」の該当フェーズの手順で今からでも記録してください（この警告はセッションにつき1回のみ表示されます）。"
jq -n --arg msg "$MSG" '{systemMessage: $msg}'

exit 0
