#!/usr/bin/env bash
set -euo pipefail

# issue #429: .claude/agents/*.md のfrontmatter model:/effort: 行、または
# .claude/workflows/*.js の opts.model/opts.effort に差分があるのに、
# 同じ差分(コミット範囲)にdocs/agents/baselines/の更新が含まれていない場合に警告する。
# issue #411の原則（新しい検知メカニズムは起動トリガーが機械か人かを先に確認する）に従い、
# CIまたはpre-commitから機械的に呼び出す想定。まずはblockではなくwarning（exit 0）で開始する。
#
# 使い方: scripts/check-agent-baseline-freshness.sh <base-ref> <head-ref>
#   例: scripts/check-agent-baseline-freshness.sh origin/main HEAD

BASE_REF="${1:-}"
HEAD_REF="${2:-HEAD}"

if [ -z "$BASE_REF" ]; then
  echo "usage: $0 <base-ref> [head-ref]" >&2
  exit 1
fi

CHANGED_FILES="$(git diff --name-only "$BASE_REF" "$HEAD_REF")"

CONFIG_CHANGED="false"
CONFIG_DETAIL=""

while IFS= read -r file; do
  [ -z "$file" ] && continue

  case "$file" in
    .claude/agents/*.md)
      DIFF_LINES="$(git diff "$BASE_REF" "$HEAD_REF" -- "$file" | grep -E '^[+-](model|effort):' || true)"
      if [ -n "$DIFF_LINES" ]; then
        CONFIG_CHANGED="true"
        CONFIG_DETAIL="$CONFIG_DETAIL
- $file (model:/effort:)"
      fi
      ;;
    .claude/workflows/*.js)
      DIFF_LINES="$(git diff "$BASE_REF" "$HEAD_REF" -- "$file" | grep -E "^[+-].*opts\.(model|effort)|^[+-].*(model|effort):" || true)"
      if [ -n "$DIFF_LINES" ]; then
        CONFIG_CHANGED="true"
        CONFIG_DETAIL="$CONFIG_DETAIL
- $file (opts.model/opts.effort相当)"
      fi
      ;;
  esac
done <<< "$CHANGED_FILES"

if [ "$CONFIG_CHANGED" = "false" ]; then
  echo "check-agent-baseline-freshness: agents設定(model/effort)の変更は検知されませんでした。"
  exit 0
fi

BASELINE_CHANGED="$(echo "$CHANGED_FILES" | grep -c '^docs/agents/baselines/' || true)"

if [ "$BASELINE_CHANGED" -eq 0 ]; then
  echo "::warning::agents設定(model/effort)が変更されていますが、docs/agents/baselines/の更新が含まれていません。変更前後のコスト・精度比較ができるよう、scripts/snapshot-agent-baseline.shでbaselineスナップショットを追加することを検討してください(issue #429)。変更箇所:$CONFIG_DETAIL"
  exit 0
fi

echo "check-agent-baseline-freshness: agents設定の変更とdocs/agents/baselines/の更新が両方含まれています。OK。"
exit 0
