#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなっていた（issue #636）。
# ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

# WHY: issue #495。「AIDD stats書き出し（~/write_aidd_stats.sh）の呼び忘れ」は棚卸し表の
# 第3層ルール（検知手段なし）だった。呼び忘れの主因は指示違反ではなく、長時間セッションでの
# コンテキスト圧縮による指示喪失であり、モデル世代によらず構造的に再発しうる。
# このスクリプトはStop hookとして毎ターン終了時に発火し、
# 「このセッションでWorkflow経由のサブエージェント実行の形跡があるのに、statsファイルに
# このセッションのstart記録が無い」場合にsystemMessageで警告する（block不可・warningのみ）。
#
# 検知ロジック:
# 1. logs/subagent-skeleton.jsonl（SubagentStart/Stop hookの機械強制記録、issue #423）から、
#    sessionIdが現在セッションと一致し、agentTranscriptPathが subagents/workflows/wf_ 配下の
#    イベントを探す。無ければWorkflow未実行セッションとして沈黙
# 2. セッション開始時刻は hook入力の transcript_path の先頭行timestampから取得する
#    （hook入力に開始時刻そのものは無いため）
# 3. statsファイル（~/.claude/aidd-session-stats/<sha256(cwd)先頭16桁>.json、
#    write_aidd_stats.shと同一のキー生成）の session_start_at（フォールバック:
#    phase1_start_at）がセッション開始時刻以降なら記録済みとして沈黙。古い値のみ・
#    ファイル無しなら「今セッションのstart呼び忘れ」として警告
#
# 設計方針:
# - fail-open: 判定材料が取れないケース（jq/python3不在・stdin欠損・transcript読めない等）は
#   すべて沈黙する。警告機能の故障でセッションを妨げない
# - 警告は同一セッションにつき1回のみ（.aidd/aidd-stats-warning-shown.json のマーカーで抑止。
#   書き込みは一時ファイル→mvのatomic方式。最悪ケースでも警告が2回出るだけで実害なし）
# - 全経路 exit 0（blockしない）
#
# 既知の限界（issue #495本文・SPEC参照）:
# - subagent-skeleton.jsonlはセッション全体で共通のため、AIDDフロー以外のWorkflow実行
#   （単発のresearch系等）も形跡として拾い、誤検知しうる（warning-onlyのため許容）
# - 検知できるのは「startの呼び忘れ」のみ（phase単位の呼び忘れは対象外）
# - 警告済みマーカーはworktree（ディレクトリ）単位の1ファイルのため、同一ディレクトリで
#   複数セッションが同時に動くと上書きし合い、「セッションにつき1回」の保証が崩れて
#   警告が余分に出ることがある（worktree分離運用が既定のため許容。実害は警告の重複のみ）
#
# 環境変数（テスト用の注入ポイント）:
#   AIDD_STATS_CHECK_SESSION_ID       hook stdinのsession_idの代替
#   AIDD_STATS_CHECK_TRANSCRIPT_PATH  hook stdinのtranscript_pathの代替
#   AIDD_STATS_CHECK_SKELETON_LOG     skeletonログパス（既定 logs/subagent-skeleton.jsonl）
#   AIDD_STATS_CHECK_STATS_DIR        statsディレクトリ（既定 ~/.claude/aidd-session-stats）
#   AIDD_STATS_CHECK_MARKER_FILE      警告済みマーカー（既定 .aidd/aidd-stats-warning-shown.json）

cd "$(dirname "$0")/.."

SKELETON_LOG="${AIDD_STATS_CHECK_SKELETON_LOG:-logs/subagent-skeleton.jsonl}"
MARKER_FILE="${AIDD_STATS_CHECK_MARKER_FILE:-.aidd/aidd-stats-warning-shown.json}"

# skeletonログが無ければWorkflow実行の形跡は取得不能 → 沈黙。
# ビルトインの存在チェックを最初に置き、AIDD未使用セッション（最頻経路）では
# サブプロセス起動ゼロで終える（レビュー指摘の反映）
[ -f "$SKELETON_LOG" ] || exit 0

# jq/python3不在の環境では判定も警告出力もできないため沈黙（fail-open）
command -v jq >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# statsディレクトリ: HOME未設定環境ではset -uクラッシュさせず沈黙（レビュー指摘の反映）
if [ -n "${AIDD_STATS_CHECK_STATS_DIR:-}" ]; then
  STATS_DIR="$AIDD_STATS_CHECK_STATS_DIR"
elif [ -n "${HOME:-}" ]; then
  STATS_DIR="$HOME/.claude/aidd-session-stats"
else
  exit 0
fi

# hook入力（stdin JSON）からsession_id / transcript_pathを取得（テスト時は環境変数で代替）
HOOK_INPUT=""
if [ -z "${AIDD_STATS_CHECK_SESSION_ID:-}" ] || [ -z "${AIDD_STATS_CHECK_TRANSCRIPT_PATH:-}" ]; then
  HOOK_INPUT="$(cat 2>/dev/null || true)"
fi
SESSION_ID="${AIDD_STATS_CHECK_SESSION_ID:-$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)}"
TRANSCRIPT_PATH="${AIDD_STATS_CHECK_TRANSCRIPT_PATH:-$(printf '%s' "$HOOK_INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || true)}"

[ -n "$SESSION_ID" ] || exit 0

# 警告済みマーカー: 同一セッションでは2回目以降沈黙
if [ -f "$MARKER_FILE" ]; then
  WARNED_SESSION="$(jq -r '.sessionId // empty' "$MARKER_FILE" 2>/dev/null || true)"
  if [ "$WARNED_SESSION" = "$SESSION_ID" ]; then
    exit 0
  fi
fi

# 1. このセッションのWorkflow経由サブエージェント実行の形跡。
# skeletonログは追記専用・無ローテーションで長期的に肥大化するため、末尾2000行に
# 走査を限定する（現在セッションのイベントは必ず末尾側に追記されている。1セッションで
# 2000件超のサブエージェントイベントは非現実的な規模。レビュー指摘の反映）
# jqは-R + fromjson?で1行ずつパースする: skeletonログは複数セッション・複数hookから
# 排他制御なしで並行追記される共有ファイルのため、壊れた行が混入しうる。素のjqだと
# 壊れた行でパースを打ち切り、それ以降の正当なイベントを見失う（レビューcritical指摘の反映）
set +e
WF_COUNT="$(tail -n 2000 "$SKELETON_LOG" 2>/dev/null \
  | jq -R -r --arg sid "$SESSION_ID" \
      'fromjson? | select(.sessionId == $sid) | .agentTranscriptPath // ""' 2>/dev/null \
  | grep -c "/subagents/workflows/wf_")"
set -e
if [ -z "$WF_COUNT" ] || [ "$WF_COUNT" -eq 0 ] 2>/dev/null; then
  exit 0
fi

# 2. セッション開始時刻（transcript先頭行のtimestamp → epoch秒）。
# 末尾ZのUTC表記のみ信頼する: Z以外（+09:00等のオフセット付き）を先頭19文字だけで
# UTCとしてパースするとサイレントにズレたepochになるため、想定外形式は沈黙に倒す
# （レビューminor指摘の反映）
[ -f "$TRANSCRIPT_PATH" ] || exit 0
# WHY: transcript の 1 行目は timestamp を持たない {"type":"bridge-session"} レコードで始まる
#      ことがある（Remote Control 連携時。2026-09-05 実測）。先頭行決め打ちだと開始時刻が取れず
#      fail-open で沈黙するため、先頭 50 行のうち最初に timestamp を持つ行を採用する
FIRST_TS="$(head -n 50 "$TRANSCRIPT_PATH" 2>/dev/null | jq -R -r 'fromjson? | .timestamp // empty' 2>/dev/null | head -n 1 || true)"
[ -n "$FIRST_TS" ] || exit 0
case "$FIRST_TS" in
  *Z) : ;;
  *) exit 0 ;;
esac
SESSION_START_EPOCH="$(python3 -c "
import sys, datetime
try:
    ts = sys.argv[1][:19]
    dt = datetime.datetime.strptime(ts, '%Y-%m-%dT%H:%M:%S').replace(tzinfo=datetime.timezone.utc)
    print(int(dt.timestamp()))
except Exception:
    pass
" "$FIRST_TS" 2>/dev/null || true)"
[ -n "$SESSION_START_EPOCH" ] || exit 0

# 3. statsファイルのstart記録（write_aidd_stats.shと同一のcwdハッシュキー）
STATS_KEY="$(python3 -c 'import hashlib, os; print(hashlib.sha256(os.getcwd().encode()).hexdigest()[:16])' 2>/dev/null || true)"
[ -n "$STATS_KEY" ] || exit 0
STATS_FILE="$STATS_DIR/$STATS_KEY.json"

START_AT=""
if [ -f "$STATS_FILE" ]; then
  START_AT="$(jq -r '.session_start_at // .phase1_start_at // empty' "$STATS_FILE" 2>/dev/null || true)"
fi
case "$START_AT" in
  *[!0-9]*) START_AT="" ;;
esac

# start記録がセッション開始以降（時計ズレ許容60秒）なら記録済み → 沈黙
if [ -n "$START_AT" ] && [ "$START_AT" -ge $((SESSION_START_EPOCH - 60)) ]; then
  exit 0
fi

# 警告前の最終ガード: 他キーのstatsファイルに今セッションのstart記録が無いか走査する。
# write_aidd_stats.shのキーは「呼び出し時点のcwd」から計算されるため、cwdドリフト
# （既知障害: EnterWorktree後にcwdが静かに戻ることがある、ユーザーMemory記載）で
# キーがズレると、実際にはstartを呼んだのに本hookの完全一致キーからは見えず
# 誤警告になる（レビューimportant指摘の反映）。誤警告よりも沈黙側に倒す。
# トレードオフ: statsディレクトリは全worktree共有（キー=cwdハッシュ）のため、この走査は
# 「他worktreeの並行セッションが直近にstartを呼んだ」場合にも沈黙し、本worktreeの
# 呼び忘れを見逃しうる。警告の信頼性（誤警告でオオカミ少年化しない）を優先した意図的な
# 選択。ディレクトリ内はworktreeごとに1ファイル程度で走査コストは無視できる
for other_file in "$STATS_DIR"/*.json; do
  [ -f "$other_file" ] || continue
  OTHER_AT="$(jq -r '.session_start_at // .phase1_start_at // empty' "$other_file" 2>/dev/null || true)"
  case "$OTHER_AT" in
    ''|*[!0-9]*) continue ;;
  esac
  if [ "$OTHER_AT" -ge $((SESSION_START_EPOCH - 60)) ]; then
    exit 0
  fi
done

# 呼び忘れと判定 → マーカーをatomicに書いてから1回だけ警告。
# マーカー書き込みに失敗しても（disk full・read-only等）クラッシュせず警告は出す
# （Stop hookの「全経路exit 0」が絶対要件のため。書けない間は毎ターン警告が繰り返される
# 可能性があるが、沈黙やクラッシュより安全側。レビューHigh指摘の反映）
write_marker() {
  local dir tmp
  dir="$(dirname "$MARKER_FILE")"
  mkdir -p "$dir" 2>/dev/null || return 1
  tmp="$(mktemp "$dir/.aidd-stats-warning.XXXXXX" 2>/dev/null)" || return 1
  jq -n --arg sid "$SESSION_ID" '{sessionId: $sid}' > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$MARKER_FILE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  return 0
}
set +e
write_marker
set -e

MSG="このセッションではWorkflow経由のサブエージェント実行（AIDDフローの可能性）が記録されていますが、AIDD statsのstart記録（~/write_aidd_stats.sh start）が見当たりません（issue #495）。長時間セッションではコンテキスト圧縮でCLAUDE.mdのstats書き出し指示が失われることがあります。AIDDフローを実行中の場合は、今からでも CLAUDE.md「AIDD stats 書き出しルール」の手順で start を呼べば、以降のphase記録・セッションレポート生成は機能します（この警告はセッションにつき1回のみ表示されます）。"
jq -n --arg msg "$MSG" '{systemMessage: $msg}'

exit 0
