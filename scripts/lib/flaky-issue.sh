#!/usr/bin/env bash
# WHY: flaky-detection.yml が揺れ・常時失敗を見つけたときに GitHub issue を作る／追記する。
#      issue を状態源にして重複作成を防ぐ（タイトル `[flaky] <suite>` で open issue を突合。
#      schema-drift-check.yml と同じ型）。ワークフローの YAML に長い bash を埋めず、ここで
#      構造テスト（scripts/lib/flaky-issue.test.sh）にかける。
#
# 使い方: SUITE=unit|integration STATUS=<check-flaky-tests.sh の exit> bash scripts/lib/flaky-issue.sh <report.md>
# 環境変数（テスト用注入ポイント）:
#   FLAKY_GH_BIN   gh の代わりに呼ぶコマンド（既定 gh）。テストでは記録用のスタブを渡す
#   GH_REPO        gh が対象リポジトリを解決できないとき（checkout 無し）に明示する
set -euo pipefail

REPORT="${1:?report.md のパスを渡す}"
SUITE="${SUITE:?SUITE を unit か integration で指定}"
STATUS="${STATUS:?STATUS に check-flaky-tests.sh の exit code を渡す}"
GH="${FLAKY_GH_BIN:-gh}"

[ -f "$REPORT" ] || { echo "レポートが無い: $REPORT" >&2; exit 1; }

TITLE="[flaky] ${SUITE}"
case "$STATUS" in
  1) KIND="揺れるテスト（flaky）" ;;
  2) KIND="毎回落ちるテスト（揺れではなくバグ）" ;;
  3) KIND="vitest 自体が起動していない（レポート不読）" ;;
  *) KIND="不明な状態（exit ${STATUS}）" ;;
esac
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT
{
  echo "## ${KIND}: ${SUITE}"
  echo ""
  echo "- 実行: ${RUN_URL}"
  echo "- レポート（run-N.json 付き）: Actions の artifact \`flaky-${SUITE}\`"
  echo "- 手元で再現: \`bash scripts/check-flaky-tests.sh --runs 5${SUITE:+ }$([ "$SUITE" = integration ] && echo '--config vitest.integration.config.ts')\`"
  echo ""
  cat "$REPORT"
  echo ""
  echo "issue #757 の 14（フレーキー検知、\`.github/workflows/flaky-detection.yml\`）により自動作成されました。"
  echo "揺れの原因（共有 fixture・並列の順序依存・時刻依存・タイムアウト）を直すか、直すまで quarantine してください。"
} > "$BODY_FILE"

EXISTING="$("$GH" issue list --state open --search "\"${TITLE}\" in:title" --json number,title --limit 20 \
  | node -e '
    const t = process.argv[1]
    let s = ""
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const rows = JSON.parse(s || "[]")
      const hit = rows.find((r) => r.title === t)
      process.stdout.write(hit ? String(hit.number) : "")
    })' "$TITLE")"

if [ -n "$EXISTING" ]; then
  "$GH" issue comment "$EXISTING" --body-file "$BODY_FILE"
  echo "issue #${EXISTING} に追記"
else
  "$GH" issue create --title "$TITLE" --label bug --body-file "$BODY_FILE"
  echo "issue を作成: ${TITLE}"
fi
