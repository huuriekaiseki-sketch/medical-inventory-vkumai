#!/usr/bin/env bash
set -euo pipefail

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
# - このため判定を2段構えにする: (1) status === "killed" は実機確認済みの確実な信号として
#   即座に対象とする。(2) status !== "completed" かつファイルの更新時刻が閾値（既定1時間、
#   WORKFLOW_INTERRUPTION_STALE_HOURSで変更可）より古い場合も対象とする
#   （check-local-main-freshness.sh等と同型の「厳密ではないが安全側」staleness近似）。
#   (2)は「正当に並行実行中の別セッションのWorkflow」を誤検知するリスクが残るため、
#   閾値は長めに取り、warning-only（block不可）に留める
#
# プロジェクトディレクトリ名の解決: Claude Codeは`~/.claude/projects/<projectDirName>/`に
# セッションtranscript・Workflow実行記録を保存する。<projectDirName>はcwdの絶対パスの
# `/`と`.`を`-`に置換したもの（実機観測で確認。例: /Users/x/repo/.claude/worktrees/y
# → -Users-x-repo--claude-worktrees-y）。worktreeごとに別ディレクトリになる
#
# 環境変数（テスト用の注入ポイント）:
#   WORKFLOW_INTERRUPTION_STALE_HOURS  staleness閾値（既定1時間）
#   WORKFLOW_INTERRUPTION_PROJECT_ROOT project transcriptディレクトリの上書き（テスト用）
#   WORKFLOW_INTERRUPTION_SEEN_FILE    既に登録済みrunIdの記録先（既定 .aidd/.workflow-interruption-seen）
#   RECOVERY_QUEUE_FILE                queue-recovery-task.shへそのまま渡す

cd "$(dirname "$0")/.."

command -v jq >/dev/null 2>&1 || exit 0

PROJECT_ROOT="${WORKFLOW_INTERRUPTION_PROJECT_ROOT:-}"
if [ -z "$PROJECT_ROOT" ]; then
  PROJECT_DIR_NAME="$(pwd | sed 's/[\/.]/-/g')"
  PROJECT_ROOT="$HOME/.claude/projects/$PROJECT_DIR_NAME"
fi
[ -d "$PROJECT_ROOT" ] || exit 0

STALE_HOURS="${WORKFLOW_INTERRUPTION_STALE_HOURS:-1}"
STALE_SECONDS=$((STALE_HOURS * 3600))
SEEN_FILE="${WORKFLOW_INTERRUPTION_SEEN_FILE:-.aidd/.workflow-interruption-seen}"
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

  MTIME_EPOCH="$(stat -f %m "$wf_file" 2>/dev/null || stat -c %Y "$wf_file" 2>/dev/null || echo 0)"
  AGE_SECONDS=$((NOW_EPOCH - MTIME_EPOCH))

  IS_TARGET=0
  if [ "$STATUS" = "killed" ]; then
    IS_TARGET=1
  elif [ "$AGE_SECONDS" -ge "$STALE_SECONDS" ]; then
    IS_TARGET=1
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
  fi
done < <(find "$PROJECT_ROOT" -path "*/workflows/wf_*.json" -print0 2>/dev/null)

exit 0
