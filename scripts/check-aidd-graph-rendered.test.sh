#!/bin/bash
# WHY: docs/aidd-pipeline.html と docs/agents/aidd-graph.md はグラフマニフェスト
#      （.claude/workflows/graph/aidd-graph.mjs）からの生成物で手編集禁止（issue #710）。
#      マニフェストを変えて再生成を忘れた PR、または生成物を手で直した PR を CI で止める。
#      CI: hooks-test（scripts/*.test.sh 一括）と docs-integrity-check.yml（docs のみの PR）の両方で回す。
#
# 実行: bash scripts/check-aidd-graph-rendered.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RENDERER="$SCRIPT_DIR/lib/render-aidd-graph.mjs"

command -v node >/dev/null 2>&1 || { echo "node が必要です"; exit 1; }

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

echo "=== scenario 1: コミット済みの生成物がマニフェストと一致する ==="
if OUT="$(node "$RENDERER" --check 2>&1)"; then
  ok "生成物は最新"
else
  ng "生成物が古い、または手編集されている" "$OUT"
fi

echo "=== scenario 2: 生成物に手編集禁止ヘッダーがある ==="
for f in docs/aidd-pipeline.html docs/agents/aidd-graph.md; do
  if grep -q 'GENERATED FILE — DO NOT EDIT' "$REPO_ROOT/$f"; then ok "$f にヘッダーがある"; else ng "$f にヘッダーが無い"; fi
done

echo "=== scenario 3: 生成物を改変すると --check が RED になる（自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
node "$RENDERER" --out "$WORK" >/dev/null
printf '\n<!-- tampered -->\n' >> "$WORK/docs/aidd-pipeline.html"
if node "$RENDERER" --check --out "$WORK" >/dev/null 2>&1; then
  ng "改変した生成物を検知できない"
else
  ok "改変を検知して exit 1"
fi

echo "=== scenario 4: 生成物が無ければ RED（fail-open 防止） ==="
EMPTY="$(mktemp -d)"
if node "$RENDERER" --check --out "$EMPTY" >/dev/null 2>&1; then
  ng "生成物不在を検知できない"
else
  ok "生成物不在で exit 1"
fi
rm -rf "$EMPTY"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
