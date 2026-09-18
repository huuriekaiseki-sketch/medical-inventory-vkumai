#!/usr/bin/env bash
# WHY(2026-09-12): Workflow の入れ子の上限（1 段）は**道具の都合**なので、こちらのコードを読んでも分からない。
#      静的な走査（`scripts/lib/scan-workflow-nesting.mjs`）は「連鎖が 2 本つながっているか」しか見ておらず、
#      **その連鎖が本当に失敗するか**は測っていない。上限が変われば走査の前提ごと古くなる。
#      だからここで**本物の Workflow 実行**に聞く——2 段は落ち、1 段は通ることを、その場で動かして確かめる。
#
#      きっかけ: 導入先のひな形 wrapper が 2 段目を呼んでいて、**導入先の入口が一度も動いていなかった**
#      （E-085・C-053）。中心リポジトリの形では 1 段に収まるため、ここでは永遠に再現しない。
#
# 何を測るか（使い捨てのリポジトリを作って、その中で claude を 1 ターン走らせる）:
#   (a) 2 段（wrapper -> router -> leaf）… 失敗し、理由に nesting を含む
#   (b) 1 段（router -> leaf）… 成功する
#
# 限界:
#   - `claude` が要る。無ければ終了コード 2（「確認できなかった」を緑にしない）
#   - 実費がかかる（実測 2026-09-12: 2 回で約 $0.1）。人が打つドリルで、CI では回さない
#   - 測るのは**入れ子の上限だけ**。プラグインの配線や hook はここでは見ない
#
# 実行: bash scripts/workflow-nesting-drill.sh
# 終了コード: 0 = 期待どおり / 1 = 期待と違う / 2 = 測れなかった
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODEL="${WORKFLOW_NESTING_DRILL_MODEL:-sonnet}"
BUDGET="${WORKFLOW_NESTING_DRILL_BUDGET:-0.3}"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude が無いので測れませんでした（このドリルは本物の Workflow 実行で確かめるものです）"
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STARTED="$(date +%s)"

# $1=置き場 $2=名前 $3=呼ぶ相手（空なら呼ばない）
make_workflow() {
  local dir="$1" name="$2" calls="${3:-}"
  mkdir -p "$dir"
  {
    echo "export const meta = {"
    echo "  name: '${name}',"
    echo "  description: '入れ子の上限を測るための使い捨て Workflow',"
    echo "  phases: [{ title: 'Run' }],"
    echo "}"
    echo "phase('Run')"
    if [ -n "$calls" ]; then
      echo "return await workflow('${calls}', {})"
    else
      echo "return { leaf: true }"
    fi
  } > "$dir/${name}.js"
}

# $1=リポジトリ $2=起動する Workflow 名 → 応答本文を返す
run_workflow() {
  local repo="$1" name="$2"
  (
    cd "$repo" || exit 9
    claude -p "Workflow ツールで ${name} を args {} で実行し、返ってきた status と summary（あれば failures も）をそのまま貼ってください。説明は不要です。" \
      --setting-sources project,local \
      --permission-mode bypassPermissions \
      --model "$MODEL" \
      --max-budget-usd "$BUDGET" \
      --output-format text 2>&1
  )
}

echo "=== (a) 2 段（wrapper -> router -> leaf）は失敗するはず ==="
DEEP="$WORK/deep"
mkdir -p "$DEEP"
make_workflow "$DEEP/.claude/workflows" drill-wrapper drill-router
make_workflow "$DEEP/.claude/workflows" drill-router drill-leaf
make_workflow "$DEEP/.claude/workflows" drill-leaf ""
OUT_DEEP="$(run_workflow "$DEEP" drill-wrapper)"
echo "$OUT_DEEP"

echo "=== (b) 1 段（router -> leaf）は通るはず ==="
SHALLOW="$WORK/shallow"
mkdir -p "$SHALLOW"
make_workflow "$SHALLOW/.claude/workflows" drill-router drill-leaf
make_workflow "$SHALLOW/.claude/workflows" drill-leaf ""
OUT_SHALLOW="$(run_workflow "$SHALLOW" drill-router)"
echo "$OUT_SHALLOW"

fail=0
if grep -q -i -e 'nesting' -e '入れ子' <<<"$OUT_DEEP"; then
  echo "  OK: 2 段は失敗し、理由に入れ子が出た"
else
  echo "  NG: 2 段が失敗しなかった（上限が変わった可能性。走査の前提を見直すこと）"
  fail=1
fi
if grep -q -i -e 'leaf' -e 'completed' -e '成功' <<<"$OUT_SHALLOW"; then
  echo "  OK: 1 段は通った"
else
  echo "  NG: 1 段まで通らない（この環境では測れていない疑い）"
  fail=1
fi

# 記録（eval と同じ台帳へ 1 行。条件と所要時間が残る）
# shellcheck source=lib/record-eval-run.sh
if [ -f "$SCRIPT_DIR/lib/record-eval-run.sh" ]; then
  source "$SCRIPT_DIR/lib/record-eval-run.sh"
  PASSED=2
  [ "$fail" -eq 0 ] || PASSED=0
  record_eval_run "workflow-nesting-drill.sh" "nesting" "$PASSED" 2 "$STARTED" "$MODEL"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
