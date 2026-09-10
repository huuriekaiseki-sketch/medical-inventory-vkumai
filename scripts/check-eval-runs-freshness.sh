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

# WHY(中身を見る、2026-09-10・レビュー指摘 R11 の後段):
#   ここは長らく「**ファイルに差分があるか**」しか見ていなかった。
#   だから **古い日付の記録・別の fixture の結果・失敗した回・木の情報が無い昔の形式**を
#   1 行足すだけで通った（レビューで再現済み）。
#   見たいのは「eval-runs.jsonl が変わったか」ではなく
#   「**いま変更したプロンプトで測った記録があるか**」なので、
#   追記された行の `workflowsTree` を HEAD の木と突き合わせる。
#
#   `workflowsDirty: true` の行は数えない——その回は clone(HEAD) から読むので、
#   **手元のプロンプトの変更が評価に入っていない**（record-eval-run.sh の WHY 参照）。
#
#   これは C-010（人が書いた印を実態と突き合わせない）そのもので、
#   ここでの「印」は**ファイルが変わったという事実**だった。
STALE_COUNT=0
if [ "$EVAL_RUNS_CHANGED" -gt 0 ]; then
  CURRENT_TREE="$(git rev-parse --verify --quiet "${HEAD_REF}:.claude/workflows" 2>/dev/null || echo "")"
  COUNTS="$(git diff "$BASE_REF" "$HEAD_REF" -- docs/agents/eval-runs.jsonl | python3 -c '
import sys, json
tree = sys.argv[1]
fresh = stale = 0
for line in sys.stdin:
    if not line.startswith("+") or line.startswith("+++"):
        continue
    body = line[1:].strip()
    if not body:
        continue
    try:
        row = json.loads(body)
    except Exception:
        # 読めない行は「測った証拠」に数えない（0 と読めないを混ぜない）
        stale += 1
        continue
    if row.get("workflowsDirty") is True:
        stale += 1
    elif tree and row.get("workflowsTree") == tree:
        fresh += 1
    else:
        stale += 1
print(fresh, stale)
' "$CURRENT_TREE" 2>/dev/null || echo "0 0")"
  read -r FRESH_COUNT STALE_COUNT <<< "$COUNTS"
  if [ "${FRESH_COUNT:-0}" -gt 0 ]; then
    echo "check-eval-runs-freshness: .claude/workflows/*.js の変更と、その木（${CURRENT_TREE:0:12}）で測った eval の記録が ${FRESH_COUNT} 行あります。OK。"
    exit 0
  fi
fi

# eval-skip 申告: PR 本文の行頭 `eval-skip:` に続く非空の理由があれば許容する
SKIP_LINE="$(printf '%s\n' "${PR_BODY:-}" | grep -m 1 -E '^[[:space:]]*eval-skip:' || true)"
if [ -n "$SKIP_LINE" ]; then
  SKIP_REASON="$(printf '%s' "$SKIP_LINE" | sed -E 's/^[[:space:]]*eval-skip:[[:space:]]*//')"
  if [ -n "$SKIP_REASON" ]; then
    echo "::notice::.claude/workflows/*.js が変更されていますが、PR本文の eval-skip 申告により eval 未実行を許容します（理由: ${SKIP_REASON}）。変更箇所:$WORKFLOWS_DETAIL"
    exit 0
  fi
  echo "::error::PR本文に eval-skip がありますが理由が空です。\`eval-skip: <理由>\` の形で理由を書いてください。"
  exit 1
fi

# 「更新が無い」と「更新はあるが古い記録だけ」は別の話。**混ぜると直し方が分からない**
if [ "$EVAL_RUNS_CHANGED" -gt 0 ]; then
  echo "::error::docs/agents/eval-runs.jsonl は更新されていますが、**いま変更したプロンプトの木（${CURRENT_TREE:0:12}）で測った記録が 1 行もありません**（追記された ${STALE_COUNT} 行は、別の木で測った回・未コミットのまま測った回（workflowsDirty）・木の情報が無い古い形式のいずれか）。変更後のプロンプトで測り直してからコミットするか、eval が不要な変更なら PR 本文に \`eval-skip: <理由>\` と書いてください。変更箇所:$WORKFLOWS_DETAIL"
  exit 1
fi

echo "::error::.claude/workflows/*.js が変更されていますが、docs/agents/eval-runs.jsonlの更新が含まれていません。マージ前にnpm run eval:workflows <fixtureセット>（sweep系の変更ならscripts/eval-sweep-recall.sh <layer>）を実行して実行痕跡をコミットするか、eval が不要な変更（コメント・定数・配線のみ等）なら PR 本文に \`eval-skip: <理由>\` と書いてください(issue #496)。変更箇所:$WORKFLOWS_DETAIL"
exit 1
