#!/usr/bin/env bash
# WHY(issue #876): dependency-audit-scheduled.yml が main の定期 audit で問題を見つけたときに
#      GitHub issue を作る／追記する。issue を状態源にして重複作成を防ぐ
#      （題名 `[audit] npm` / `[env] npm audit` で open issue を完全一致で突合。flaky-issue.sh と同じ型）。
#      判定と本文の組み立ては scripts/lib/audit-report.mjs、ここは gh を叩くだけ。
#
#      きっかけ: npm audit は PR を出したときにしか走らず、作業が止まっている間に公開された脆弱性に
#      気づけなかった。2026-09-30 公開の Next.js の critical（GHSA-vcvr-r3jv-pc5j）は 10-02 に
#      無関係な PR 2 本（#879・#880）を同時に赤くして初めて分かった（導入先 kojigyo-zei-rag でも同じ形）。
#
# 使い方: STATUS=<npm audit の exit> bash scripts/lib/audit-issue.sh <audit.json>
# 環境変数（テスト用注入ポイント）:
#   AUDIT_GH_BIN   gh の代わりに呼ぶコマンド（既定 gh）。テストでは記録用のスタブを渡す
set -euo pipefail

INPUT="${1:?audit.json のパスを渡す}"
STATUS="${STATUS:?STATUS に npm audit の exit code を渡す}"
GH="${AUDIT_GH_BIN:-gh}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -f "$INPUT" ] || { echo "audit の出力が無い: $INPUT" >&2; exit 1; }

RENDERED="$(mktemp)"
BODY_FILE="$(mktemp)"
trap 'rm -f "$RENDERED" "$BODY_FILE"' EXIT
node "$SCRIPT_DIR/audit-report.mjs" "$INPUT" "$STATUS" > "$RENDERED"

TITLE="$(sed -n 1p "$RENDERED")"
LABEL="$(sed -n 2p "$RENDERED")"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
{
  sed -n '3,$p' "$RENDERED"
  echo ""
  echo "- 実行: ${RUN_URL}"
  echo "- 生の出力: Actions の artifact \`dependency-audit\`（\`audit.json\`）"
  echo "- 手元で再現: \`npm audit --omit=dev --audit-level=high\`"
  echo ""
  echo "issue #876（main の定期 audit、\`.github/workflows/dependency-audit-scheduled.yml\`）により自動作成されました。"
  echo "直したあとこの issue は自動では閉じません。main で audit が緑に戻ったことを確かめて閉じてください。"
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
  "$GH" issue create --title "$TITLE" --label "$LABEL" --body-file "$BODY_FILE"
  echo "issue を作成: ${TITLE}"
fi
