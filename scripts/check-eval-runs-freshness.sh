#!/usr/bin/env bash
set -euo pipefail

# issue #496: .claude/workflows/*.js に差分があるのに、同じ差分(コミット範囲)に
# docs/agents/eval-runs.jsonl(scripts/eval-workflow-prompts.sh / scripts/eval-sweep-recall.sh
# が実行完了時に自動追記するJSONL)の更新が含まれていない場合に失敗させる。
# scripts/check-agent-baseline-freshness.sh(issue #429)と同型。
#
# WHY(2026-09-05、warning → error への変更): 2026-07-23 の導入時は「まずは warning で開始」としたが、
# ::warning:: は Actions の run を開かないと見えず、その後 .claude/workflows を変えた PR 3 件
# （#627 #679 #693）で警告が出たまま誰にも気づかれずマージされ、eval-runs.jsonl の記録は
# 2026-07-23 で止まっていた。「検知は動いているが届いていない」状態だったため、PR の checks に
# 赤として現れる exit 1 に切り替える。ただし eval は実エージェントを呼びコストがかかるので、
# コメント修正・定数変更のような PR は PR 本文に `eval-skip: <理由>` と書けば通す
# （理由は本文に残るので後から追える。空の理由は認めない）。
#
# 使い方: scripts/check-eval-runs-freshness.sh <base-ref> <head-ref>
#   例: scripts/check-eval-runs-freshness.sh origin/main HEAD
# 環境変数:
#   PR_BODY  PR 本文（CI が github.event.pull_request.body を渡す）。`eval-skip: <理由>` 行があれば
#            eval-runs.jsonl 未更新でも exit 0

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

if [ "$EVAL_RUNS_CHANGED" -gt 0 ]; then
  echo "check-eval-runs-freshness: .claude/workflows/*.js の変更とdocs/agents/eval-runs.jsonlの更新が両方含まれています。OK。"
  exit 0
fi

# eval-skip 申告: PR 本文の行頭 `eval-skip:` に続く非空の理由があれば許容する
SKIP_LINE="$(printf '%s\n' "${PR_BODY:-}" | grep -m 1 -E '^[[:space:]]*eval-skip:' || true)"
if [ -n "$SKIP_LINE" ]; then
  SKIP_REASON="$(printf '%s' "$SKIP_LINE" | sed -E 's/^[[:space:]]*eval-skip:[[:space:]]*//')"
  if [ -n "$SKIP_REASON" ]; then
    echo "::notice::.claude/workflows/*.js が変更されていますが、PR本文の eval-skip 申告により eval 未実行を許容します（理由: $SKIP_REASON）。変更箇所:$WORKFLOWS_DETAIL"
    exit 0
  fi
  echo "::error::PR本文に eval-skip がありますが理由が空です。\`eval-skip: <理由>\` の形で理由を書いてください。"
  exit 1
fi

echo "::error::.claude/workflows/*.js が変更されていますが、docs/agents/eval-runs.jsonlの更新が含まれていません。マージ前にnpm run eval:workflows <fixtureセット>（sweep系の変更ならscripts/eval-sweep-recall.sh <layer>）を実行して実行痕跡をコミットするか、eval が不要な変更（コメント・定数・配線のみ等）なら PR 本文に \`eval-skip: <理由>\` と書いてください(issue #496)。変更箇所:$WORKFLOWS_DETAIL"
exit 1
