#!/usr/bin/env bash
set -euo pipefail

# issue #496: .claude/workflows/*.js に差分があるのに、同じ差分(コミット範囲)に
# docs/agents/eval-runs.jsonl(scripts/eval-workflow-prompts.sh / scripts/eval-sweep-recall.sh
# が実行完了時に自動追記するJSONL)の更新が含まれていない場合に警告する。
# scripts/check-agent-baseline-freshness.sh(issue #429)と同型。まずはblockではなく
# warning(exit 0)で開始する。
#
# 使い方: scripts/check-eval-runs-freshness.sh <base-ref> <head-ref>
#   例: scripts/check-eval-runs-freshness.sh origin/main HEAD

BASE_REF="${1:-}"
HEAD_REF="${2:-HEAD}"

if [ -z "$BASE_REF" ]; then
  echo "usage: $0 <base-ref> [head-ref]" >&2
  exit 1
fi

CHANGED_FILES="$(git diff --name-only "$BASE_REF" "$HEAD_REF")"

WORKFLOWS_CHANGED="false"
WORKFLOWS_DETAIL=""

while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    .claude/workflows/*.js)
      WORKFLOWS_CHANGED="true"
      WORKFLOWS_DETAIL="$WORKFLOWS_DETAIL
- $file"
      ;;
  esac
done <<< "$CHANGED_FILES"

if [ "$WORKFLOWS_CHANGED" = "false" ]; then
  echo "check-eval-runs-freshness: .claude/workflows/*.js の変更は検知されませんでした。"
  exit 0
fi

EVAL_RUNS_CHANGED="$(echo "$CHANGED_FILES" | grep -c '^docs/agents/eval-runs\.jsonl$' || true)"

if [ "$EVAL_RUNS_CHANGED" -eq 0 ]; then
  echo "::warning::.claude/workflows/*.js が変更されていますが、docs/agents/eval-runs.jsonlの更新が含まれていません。マージ前にnpm run eval:workflows（またはsweep系の変更ならscripts/eval-sweep-recall.sh）を実行し、実行痕跡を記録することを検討してください(issue #496)。変更箇所:$WORKFLOWS_DETAIL"
  exit 0
fi

echo "check-eval-runs-freshness: .claude/workflows/*.js の変更とdocs/agents/eval-runs.jsonlの更新が両方含まれています。OK。"
exit 0
