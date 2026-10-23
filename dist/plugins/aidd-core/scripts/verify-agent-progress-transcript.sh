#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--log-file PATH] [--project-dir PATH] [--json]" >&2
  echo "  logs/agent-progress.jsonl の自己申告(status=done|failed)と" >&2
  echo "  ~/.claude/projects/**/subagents/workflows/wf_*/agent-<id>.jsonl の実transcriptを" >&2
  echo "  機械的に突き合わせ、status/detailの食い違いを検出する（issue #369の②スコープ）。" >&2
  echo "  LLM呼び出しなし。食い違いがあればexit 1。" >&2
  exit 1
}

ARGS=()
LOG_FILE_GIVEN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --log-file) ARGS+=(--log-file "$2"); LOG_FILE_GIVEN=1; shift 2 ;;
    --project-dir) ARGS+=(--project-dir "$2"); shift 2 ;;
    --json) ARGS+=(--json); shift ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

# issue #546: --log-fileが明示されなかった場合は、TS側のcwd相対デフォルト
# （'logs/agent-progress.jsonl'）に頼らず、worktree横断で共有されるlogs/を渡す。
if [[ "$LOG_FILE_GIVEN" -eq 0 ]]; then
  ARGS=(--log-file "$(resolve_log_dir)/agent-progress.jsonl" "${ARGS[@]}")
fi

# WHY(issue #805): 骨格ログも同じ。#546 のときに --log-file だけを共有側へ向け、こちらを渡し忘れていた。
# TS 側の既定（logs/subagent-skeleton.jsonl）は cwd 相対なので、git worktree から動かすと
# 自己申告は共有側・突き合わせる骨格は worktree 直下、と別々の場所を読んでいた。
# このラッパーは --skeleton-log-file を引数として受けないので、常に共有側を渡す
ARGS=(--skeleton-log-file "$(resolve_log_dir)/subagent-skeleton.jsonl" "${ARGS[@]}")

# WHY（issue #902、骨格ログの SubagentHandback 行をどこまで突合に使えるか）:
#   auto mode では報告本文が SubagentStop の lastAssistantMessage ではなく hookEvent=SubagentHandback
#   行の message に入る。canonical-event.ts の骨格アダプタはその message を detail に写すので、
#   同じ agentId の束に報告本文は届く。ただし突合の判定材料になるのは次の範囲まで:
#   - status の食い違い検出には使えない。骨格行は status を持たない（pass/fail/blocked は
#     ペイロードに無い）ので、buildReport は journal の無い束を「未突合」に落とす。ここは従来どおり
#   - detail の低重複検出は、journal の無い束では骨格行が anchor にならないため、やはり走らない
#   つまり本文が残っても、この検査の数字（突合成功・未突合）は SubagentHandback 行の有無で変わらない。
#   本文が効くのは、未突合の行を人が辿るときに agentTranscriptPath を開かずに済む、という一点。
#   Workflow 経由（journal あり）の束では journal の detail が優先されるので、こちらも変わらない。

# WHY: npx tsx はレジストリ依存で遅い日に数分かかる（harvest-journal-events.sh のコメント参照）。
#      Node 標準の型除去で直接実行する
node --experimental-strip-types --no-warnings "$SCRIPT_DIR/lib/verify-agent-progress-transcript.ts" "${ARGS[@]}"
