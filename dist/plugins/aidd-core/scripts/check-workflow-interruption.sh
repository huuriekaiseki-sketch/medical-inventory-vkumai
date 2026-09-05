#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなっていた（issue #636）。
# ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

# WHY: issue #534（issue #523フォローアップ）。docs/agents/recovery-queue.md
# 「今後この機能を拡張する場合」の手順に従う。
#
# 実機観測（2026-07-25、issue #534）で確定した事実:
# - TaskStopで明示的にWorkflow実行を中断すると、<transcript配置ディレクトリ>/<session>/
#   workflows/wf_*.json の status フィールドは確実に "killed" になる（"completed"とは
#   明確に区別できる。result: null、error: "Error: Workflow aborted..." も併記される）
# - 正常完了時は status: "completed"
#
# 未検証のまま残る既知の限界（このリポジトリの一貫した方針どおり不確かな検知能力を
# 実装済みと詐称しない）:
# - 本来ターゲットにしたい失敗モード（セッション自体がクラッシュ・タイムアウト等で
#   異常終了しWorkflowが取り残されるケース）は、TaskStop経由のabort()コードパスを
#   通らない可能性が高く、"killed"が書き込まれないまま放置される懸念が残る。
#   セッションを実際にクラッシュさせて検証することは安全に行えないため未検証のまま
# - staleness判定（下記）が前提とする「wf_*.jsonのmtimeは実行中も更新され続ける」という
#   仮定自体、部分的にしか実機確認できていない（issue #534 PRレビュー指摘）。中断直後
#   （起動から2.2秒後）に読んだファイルが1件目のagent()呼び出しの"start"状態を反映して
#   いたことは確認できた（＝起動時に1回書いて放置、ではない）が、1回のagent()呼び出し
#   自体が長時間（Fable 5は数分〜数時間になりうる）かかる間もmtimeが更新され続けるかは
#   確認できていない（監視用の別プロセスを起動する頃には検証対象のprobe Workflowが
#   先に完了してしまい、進行中スナップショットを捕捉できなかった）
# - このため判定を2段構えにする: (1) status === "killed" は実機確認済みの確実な信号として
#   即座に対象とする。(2) status !== "completed" かつファイルの更新時刻が閾値（既定4時間、
#   WORKFLOW_INTERRUPTION_STALE_HOURSで変更可）より古い場合も対象とする
#   （check-local-main-freshness.sh等と同型の「厳密ではないが安全側」staleness近似）。
#   (2)は「正当に長時間実行中のWorkflow（自セッション・他セッション問わず）」を誤検知する
#   リスクが残るため、上記の未検証点を踏まえて閾値を長め（既定4時間）に取り、
#   warning-only（block不可）に留める。より確実な検証ができ次第、この閾値・判定条件は
#   見直すこと
#
# プロジェクトディレクトリ名の解決: Claude Codeは`~/.claude/projects/<projectDirName>/`に
# セッションtranscript・Workflow実行記録を保存する。<projectDirName>はcwdの絶対パスの
# `/`と`.`を`-`に置換したもの（実機観測で確認。例: /Users/x/repo/.claude/worktrees/y
# → -Users-x-repo--claude-worktrees-y）。worktreeごとに別ディレクトリになる
#
# 環境変数（テスト用の注入ポイント）:
#   WORKFLOW_INTERRUPTION_STALE_HOURS  staleness閾値（既定4時間）
#   WORKFLOW_INTERRUPTION_PROJECT_ROOT project transcriptディレクトリの上書き（テスト用）
#   WORKFLOW_INTERRUPTION_SEEN_FILE    既に登録済みrunIdの記録先（既定 .aidd/.workflow-interruption-seen）
#   WORKFLOW_INTERRUPTION_SEEN_MAX     seen fileの無制限肥大化を防ぐ保持件数上限（既定500）
#   RECOVERY_QUEUE_FILE                queue-recovery-task.shへそのまま渡す

cd "$(dirname "$0")/.."

command -v jq >/dev/null 2>&1 || exit 0

PROJECT_ROOT="${WORKFLOW_INTERRUPTION_PROJECT_ROOT:-}"
if [ -z "$PROJECT_ROOT" ]; then
  PROJECT_DIR_NAME="$(pwd | sed 's/[\/.]/-/g')"
  PROJECT_ROOT="$HOME/.claude/projects/$PROJECT_DIR_NAME"
fi
[ -d "$PROJECT_ROOT" ] || exit 0

STALE_HOURS="${WORKFLOW_INTERRUPTION_STALE_HOURS:-4}"
STALE_SECONDS=$((STALE_HOURS * 3600))
SEEN_FILE="${WORKFLOW_INTERRUPTION_SEEN_FILE:-.aidd/.workflow-interruption-seen}"
SEEN_MAX="${WORKFLOW_INTERRUPTION_SEEN_MAX:-500}"
mkdir -p "$(dirname "$SEEN_FILE")"
touch "$SEEN_FILE"

NOW_EPOCH=$(date +%s)

while IFS= read -r -d '' wf_file; do
  STATUS="$(jq -r '.status // empty' "$wf_file" 2>/dev/null || true)"
  [ -n "$STATUS" ] || continue
  [ "$STATUS" != "completed" ] || continue

  RUN_ID="$(jq -r '.runId // empty' "$wf_file" 2>/dev/null || true)"
  [ -n "$RUN_ID" ] || continue

  # 既にキュー登録済みのrunIdは再登録しない（wf_*.jsonはセッションをまたいで
  # 永続するファイルのため、これが無いと毎SessionStartで同じ中断を再登録し続けてしまう）
  grep -qxF "$RUN_ID" "$SEEN_FILE" 2>/dev/null && continue

  WORKFLOW_NAME="$(jq -r '.workflowName // empty' "$wf_file" 2>/dev/null || true)"

  IS_TARGET=0
  if [ "$STATUS" = "killed" ]; then
    IS_TARGET=1
  else
    # statが両OSとも失敗した場合はfail-open（staleness判定をスキップ）する。
    # PRレビュー指摘: 失敗時にepoch 0へフォールバックすると「無限に古い」扱いになり
    # warning側へ倒れてしまう（このスクリプトの他の箇所のfail-open方針と矛盾する）
    # GNU stat(Linux)では`stat -f %m`が「失敗せず」ファイルシステム情報の文字列を返すため、
    # BSD形式を先に試す従来の書き方だとLinuxで非数値が混入し、算術式がset -uでクラッシュした
    # (CI hooks-test初回実行で検出)。GNU形式を先に試し、さらに数値でない値はfail-open扱いにする。
    MTIME_EPOCH="$(stat -c %Y "$wf_file" 2>/dev/null || stat -f %m "$wf_file" 2>/dev/null || true)"
    case "$MTIME_EPOCH" in
      ''|*[!0-9]*) MTIME_EPOCH="" ;;
    esac
    if [ -n "$MTIME_EPOCH" ]; then
      AGE_SECONDS=$((NOW_EPOCH - MTIME_EPOCH))
      [ "$AGE_SECONDS" -ge "$STALE_SECONDS" ] && IS_TARGET=1
    fi
  fi

  [ "$IS_TARGET" -eq 1 ] || continue

  DETAIL="$(jq -nc \
    --arg runId "$RUN_ID" \
    --arg workflowName "$WORKFLOW_NAME" \
    --arg status "$STATUS" \
    --arg wfFile "$wf_file" \
    --arg runbook "docs/agents/workflow-resume-runbook.md" \
    '{runId: $runId, workflowName: $workflowName, status: $status, wfFile: $wfFile, runbook: $runbook}')"

  if bash scripts/queue-recovery-task.sh --type "workflow-interrupted" --detail "$DETAIL" >/dev/null 2>&1; then
    echo "$RUN_ID" >> "$SEEN_FILE"
    # PRレビュー指摘: seen fileが無期限に追記され続けるとローテーションが無い。
    # 直近SEEN_MAX件のみ保持する（古いrunIdを忘れても実害は「稀に再登録される」程度で
    # 軽微なため、シンプルさを優先する）
    TAIL_TMP="$(mktemp "$(dirname "$SEEN_FILE")/.seen-tail.XXXXXX" 2>/dev/null || true)"
    if [ -n "$TAIL_TMP" ]; then
      tail -n "$SEEN_MAX" "$SEEN_FILE" > "$TAIL_TMP" 2>/dev/null && mv "$TAIL_TMP" "$SEEN_FILE" || rm -f "$TAIL_TMP"
    fi
  fi
done < <(find "$PROJECT_ROOT" -path "*/workflows/wf_*.json" -print0 2>/dev/null)

exit 0
