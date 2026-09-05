#!/usr/bin/env bash
set -euo pipefail

# WHY: issue #712。SessionStart hook（matcher: compact）から呼ばれ、context compaction の直後に
#      「今の AIDD 実行状態」だけを additionalContext として再注入する。
#
#      Claude Code の compaction 仕様（公式 context-window ドキュメント「What survives compaction」）:
#        - プロジェクトルート CLAUDE.md・unscoped rules・auto memory はディスクから再注入される
#        - hook が以前に注入したコンテキストは会話と一緒に要約されて薄れる
#        - source: "compact" にマッチする SessionStart hook だけが compaction 後に再実行される
#      従来は SessionStart hook 12 本すべてが matcher 無しで、compact 時にもブランチ鮮度・
#      worktree 残骸などの警告 12 本が再実行される一方、長時間の AIDD 自律実行で本当に必要な
#      「どの run-manifest で・どのエージェントがどこまで進み・未対応の復旧タスクは何か」は
#      要約で薄れていた。本スクリプトはその逆転を直す。
#
# 出力するもの（存在するものだけ。全部無ければ何も出力しない）:
#   1. .aidd/run-manifest.json の要約（specPath / specHash / baseCommit / approval / changedFiles 件数）
#   2. logs/agent-progress.jsonl の最新状態（scripts/show-agent-status.sh の出力、先頭 20 行）
#   3. .aidd/recovery-queue.jsonl の未解決エントリ数（pending + surfaced）
#   4. CLAUDE.md の再注入済みルールへのポインタ（本文は重複させない）
#
# ガード: stdin の hook 入力 JSON に source があり "compact" 以外なら何もしない（matcher の
#         設定ミスで startup 等にも登録された場合の二重注入防止）。REINJECT_FORCE=1 で無効化。
# 全経路 exit 0（block 不可の SessionStart のため）。jq 不在なら静かに終了（fail-open。他の
# SessionStart hook と同じ方針、issue #636）。
#
# 環境変数（テスト用の注入ポイント）:
#   AIDD_MANIFEST_PATH   run-manifest のパス（既定 .aidd/run-manifest.json）
#   RECOVERY_QUEUE_FILE  復旧キューのパス（既定 .aidd/recovery-queue.jsonl）
#   AGENT_PROGRESS_LOG   進捗ログのパス（既定 scripts/lib/resolve-log-dir.sh が解決する logs/agent-progress.jsonl）
#   REINJECT_FORCE       1 なら source ガードを無効化

command -v jq >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY(issue #420): プラグイン配布ではスクリプト位置がリポジトリ外になるため CLAUDE_PROJECT_DIR を優先する
cd "${CLAUDE_PROJECT_DIR:-$SCRIPT_DIR/..}"

INPUT="$(cat 2>/dev/null || true)"
if [ "${REINJECT_FORCE:-0}" != "1" ] && [ -n "$INPUT" ]; then
  SOURCE="$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null || true)"
  if [ -n "$SOURCE" ] && [ "$SOURCE" != "compact" ]; then
    exit 0
  fi
fi

MANIFEST="${AIDD_MANIFEST_PATH:-.aidd/run-manifest.json}"
QUEUE_FILE="${RECOVERY_QUEUE_FILE:-.aidd/recovery-queue.jsonl}"
if [ -n "${AGENT_PROGRESS_LOG:-}" ]; then
  PROGRESS_LOG="$AGENT_PROGRESS_LOG"
else
  # shellcheck source=lib/resolve-log-dir.sh
  source "$SCRIPT_DIR/lib/resolve-log-dir.sh"
  PROGRESS_LOG="$(resolve_log_dir)/agent-progress.jsonl"
fi

SECTIONS=""

if [ -f "$MANIFEST" ]; then
  MANIFEST_SUMMARY="$(jq -r '
    "- specPath: \(.specPath // "（未設定）")",
    "- specHash: \((.specHash // "（未設定）") | .[0:12])",
    "- baseCommit: \((.baseCommit // "（未設定）") | .[0:12])",
    "- 停止①承認: \(if .approval and .approval.approvedBy then "\(.approval.approvedBy) @ \(.approval.approvedAt // "?")" else "未承認（Phase 3 以降へ進めない）" end)",
    "- changedFiles: \((.changedFiles // []) | length) 件"
  ' "$MANIFEST" 2>/dev/null || echo "- （run-manifest.json の解析に失敗。Read ツールで直接確認すること）")"
  SECTIONS="${SECTIONS}
## AIDD Run Manifest（${MANIFEST}）
${MANIFEST_SUMMARY}"
fi

if [ -f "$PROGRESS_LOG" ] && [ -x "$SCRIPT_DIR/show-agent-status.sh" ]; then
  PROGRESS="$(bash "$SCRIPT_DIR/show-agent-status.sh" --log-file "$PROGRESS_LOG" 2>/dev/null | head -n 20 || true)"
  if [ -n "$PROGRESS" ]; then
    SECTIONS="${SECTIONS}

## サブエージェント進捗（${PROGRESS_LOG}、最新 20 行）
${PROGRESS}"
  fi
fi

if [ -f "$QUEUE_FILE" ]; then
  UNRESOLVED="$(jq -R -r 'fromjson? | select(.status == "pending" or .status == "surfaced") | "- [\(.type)] id=\(.id) status=\(.status)"' "$QUEUE_FILE" 2>/dev/null || true)"
  if [ -n "$UNRESOLVED" ]; then
    SECTIONS="${SECTIONS}

## 未解決の復旧タスク（${QUEUE_FILE}）
${UNRESOLVED}
対応後は scripts/resolve-recovery-task.sh --id <ID> で解決済みにする"
  fi
fi

if [ -z "$SECTIONS" ]; then
  exit 0
fi

CONTEXT="context compaction 後の AIDD 実行状態の再注入（scripts/reinject-aidd-run-state.sh、issue #712）。
以下はディスク上の状態ファイルから読み直した現在値であり、要約前の会話より新しい。
${SECTIONS}

## ルールの所在
- 「絶対ルール」「サーキットブレーカー」「AIDD stats 書き出しルール」「gap check state 記録ルール」は、compaction 後に再注入された CLAUDE.md を参照する（ここには重複させない）
- /goal の停止条件は会話内にしか無い。フロー開始時に設定していたなら、その条件（ターン数上限を含む）に引き続き従うこと"

jq -n --arg ctx "$CONTEXT" '{
  systemMessage: "compaction 後に AIDD 実行状態（run-manifest / 進捗 / 復旧キュー）を再注入しました（issue #712）",
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
