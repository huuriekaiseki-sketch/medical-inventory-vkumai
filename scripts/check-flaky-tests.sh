#!/usr/bin/env bash
# WHY: issue #757 の 14（フレーキー検知）。同じテストを N 回回し、通ったり落ちたりするテストを機械で洗い出す。
#      同時実行（P-050 / P-052）・冪等性（P-053）の統合テストは実 DB で並列に走るため揺れやすく、
#      揺れたテストは「たまたま通った緑」を生む。週次の cron（.github/workflows/flaky-detection.yml）と
#      手元の両方で同じスクリプトを使う。
#
# 使い方: bash scripts/check-flaky-tests.sh [--runs N] [--config FILE] [--out DIR] [--] [vitest の引数...]
#   --runs N      実行回数（既定 3）
#   --config FILE vitest の設定（既定は vitest.config.ts = unit。統合は vitest.integration.config.ts）
#   --out DIR     レポートの置き場（既定は一時ディレクトリ。flaky-report.md と run-N.json を置く）
#   残りの引数はそのまま vitest に渡す（特定ファイルだけ回すときなど）
# 終了コード: scripts/lib/flaky-aggregate.mjs と同じ（0 なし / 1 flaky / 2 常時失敗のみ / 3 レポート不読 / 4 環境事故のみ）
#
# 環境変数（テスト用注入ポイント）:
#   FLAKY_VITEST_BIN  vitest の起動コマンド（既定 "npx vitest"）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGGREGATE="$SCRIPT_DIR/lib/flaky-aggregate.mjs"

RUNS=3
CONFIG=""
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --runs) RUNS="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --) shift; break ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) break ;;
  esac
done

case "$RUNS" in
  ''|*[!0-9]*) echo "--runs は正の整数で指定してください: $RUNS" >&2; exit 3 ;;
esac
[ "$RUNS" -ge 1 ] || { echo "--runs は 1 以上" >&2; exit 3; }

if [ -z "$OUT" ]; then
  OUT="$(mktemp -d)"
fi
mkdir -p "$OUT"

cd "$REPO_ROOT"
VITEST_BIN="${FLAKY_VITEST_BIN:-npx vitest}"

echo "フレーキー検知: ${RUNS} 回実行（config: ${CONFIG:-vitest.config.ts}、out: ${OUT}）"
for i in $(seq 1 "$RUNS"); do
  echo "--- run $i / $RUNS ---"
  set +e
  # shellcheck disable=SC2086
  $VITEST_BIN run ${CONFIG:+--config "$CONFIG"} --reporter=dot --reporter=json --outputFile.json="$OUT/run-$i.json" "$@"
  status=$?
  set -e
  echo "run $i: exit $status"
done

echo "--- 集計 ---"
set +e
node "$AGGREGATE" --md "$OUT/flaky-report.md" "$OUT"/run-*.json
result=$?
set -e
echo "レポート: $OUT/flaky-report.md"
exit "$result"
