#!/usr/bin/env bash
# WHY: issue #757 の 35。**リポジトリを正本として**、実環境の権限・ポリシーがそこからずれていないかを見る。
#      スキーマドリフト検知（issue #305）が DB 内部のスナップショット同士を比べるのに対し、
#      こちらは「migration から導いた期待値」と実環境を比べる。
#      PR を通さずダッシュボードや SQL Editor で権限を足した、を見つけるのが目的。
#
# 使い方:
#   bash scripts/check-config-drift.sh                 # 既定の接続先（ローカル Supabase）
#   CONFIG_DRIFT_URL=... CONFIG_DRIFT_KEY=... bash scripts/check-config-drift.sh
#
#   CONFIG_DRIFT_URL / CONFIG_DRIFT_KEY を渡せば staging / 本番にも向けられる
#   （鍵は service_role。public.config_snapshot() は service_role にしか許していない）。
#   渡さなければ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を使う。
#
# 判定:
#   差分なし → 何も言わず exit 0
#   差分あり → 名指しして exit 1
#   **繋げない・鍵が無い → 「確認不能」と言って exit 0**（合格にも違反にも数えない）
#     WHY: 接続できないことを「差分なし」と読むと、**見ていないのに緑**になる。
#          かといって赤にすると、DB を立てていない人の作業を毎回止める。
#          docs/agents/check-design-pitfalls.md の「『何かが起きた』を成功と読まない」。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "  SKIP: 確認不能（node が無いので期待値を作れません）"
  exit 0
fi
if [ ! -d "$REPO_ROOT/supabase/migrations" ]; then
  echo "  SKIP: supabase/migrations が無いので対象なし"
  exit 0
fi

node --input-type=module -e '
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

const root = process.argv[1]
const { buildExpected } = await import(path.join(root, "scripts/lib/build-config-expected.mjs"))
const { compareGrants, comparePolicies, formatFindings } = await import(
  path.join(root, "scripts/lib/compare-config.mjs")
)

// env ファイルから読む（値は表示しない）。
// WHY(.env.test を先に見る): 手元で回すときの相手は**ローカル Supabase**。
//   .env.local は本番プロジェクトを指していることがあり、そちらを既定にすると
//   「本番に向けて 404」で毎回 確認不能 になる（2026-09-18 に実際にそうなった）。
//   本番・staging へ向けるときは CONFIG_DRIFT_URL / CONFIG_DRIFT_KEY を明示的に渡す。
function fromEnvFile(name) {
  for (const f of [".env.test", ".env.local", ".env"]) {
    const p = path.join(root, f)
    if (!existsSync(p)) continue
    const m = new RegExp(`^${name}=(.*)$`, "m").exec(readFileSync(p, "utf8"))
    if (m) return m[1].trim().replace(/^"|"$/g, "")
  }
  return undefined
}

const url = process.env.CONFIG_DRIFT_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? fromEnvFile("NEXT_PUBLIC_SUPABASE_URL")
const key = process.env.CONFIG_DRIFT_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? fromEnvFile("SUPABASE_SERVICE_ROLE_KEY")

if (!url || !key) {
  console.log("  SKIP: 確認不能（接続先か service_role の鍵が無いので実環境を読めません）")
  process.exit(0)
}

let actual
try {
  const res = await fetch(`${url}/rest/v1/rpc/config_snapshot`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    console.log(`  SKIP: 確認不能（config_snapshot を呼べません: HTTP ${res.status}）`)
    process.exit(0)
  }
  actual = await res.json()
} catch (e) {
  console.log(`  SKIP: 確認不能（実環境へ繋げません: ${e.message}）`)
  process.exit(0)
}

if (!actual || !Array.isArray(actual.tableGrants)) {
  console.log("  SKIP: 確認不能（config_snapshot の形が読めません）")
  process.exit(0)
}

const expected = buildExpected(root)
if (expected.unparsed.length > 0) {
  console.log("  NG: migration に読めない GRANT/REVOKE があります（期待値が不完全なので比較しません）")
  for (const u of expected.unparsed) console.log(`    ${u}`)
  process.exit(1)
}

const findings = [
  ...formatFindings("表", compareGrants(expected.tableGrants, actual.tableGrants)),
  ...formatFindings("関数", compareGrants(expected.functionGrants, actual.functionGrants)),
  ...formatFindings("ポリシー", comparePolicies(expected.policies, actual.policies)),
]

if (findings.length === 0) {
  process.exit(0)
}
console.log("  NG: リポジトリと実環境の設定がずれています（issue #757 の 35）")
for (const f of findings) console.log(f)
console.log("  直し方: 実環境側の変更が正しいなら migration にしてから当て直す。")
console.log("          リポジトリ側が正しいなら、実環境の手動変更を取り消す。")
process.exit(1)
' "$REPO_ROOT"
