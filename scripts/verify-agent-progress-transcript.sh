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
while [[ $# -gt 0 ]]; do
  case "$1" in
    --log-file) ARGS+=(--log-file "$2"); shift 2 ;;
    --project-dir) ARGS+=(--project-dir "$2"); shift 2 ;;
    --json) ARGS+=(--json); shift ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

npx -y tsx "$SCRIPT_DIR/lib/verify-agent-progress-transcript.ts" "${ARGS[@]}"
