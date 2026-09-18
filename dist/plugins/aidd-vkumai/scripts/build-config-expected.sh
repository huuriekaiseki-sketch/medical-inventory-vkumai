#!/usr/bin/env bash
# WHY: issue #757 の 35。期待値（docs/agents/config-expected.json）と .env.example を
#      migration・コードの走査から作り直す。**どちらも生成物なので手で編集しない。**
#
# 使い方:
#   bash scripts/build-config-expected.sh           # 書き出す
#   bash scripts/build-config-expected.sh --check   # 最新かだけ見る（古ければ exit 1）
#
# 生成物をコミットするのは、このリポジトリの他の生成物（harness-map.md・dist/plugins・
# aidd-graph）と同じ型。コミットしないと「いつの姿に対する期待値か」が追えない。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="${1:-write}"

command -v node >/dev/null 2>&1 || { echo "node が必要です"; exit 1; }

node --input-type=module -e '
import { writeFileSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"

const root = process.argv[1]
const mode = process.argv[2]
const { buildExpected } = await import(path.join(root, "scripts/lib/build-config-expected.mjs"))

const expected = buildExpected(root)
const jsonPath = path.join(root, "docs/agents/config-expected.json")
const envPath = path.join(root, ".env.example")

const json = JSON.stringify(expected, null, 2) + "\n"

const envLines = [
  "# 生成物。手で編集しない（bash scripts/build-config-expected.sh）。",
  "# issue #757 の 35。src/ の process.env.* の走査から作る。**値は書かない**（名前だけ）。",
  "# 値の実物は各環境（Vercel / ローカルの .env.local）に置く。",
  "",
  ...expected.envNames.map((n) => `${n}=`),
  "",
]
const env = envLines.join("\n")

if (mode === "--check") {
  const problems = []
  if (!existsSync(jsonPath) || readFileSync(jsonPath, "utf8") !== json) {
    problems.push("docs/agents/config-expected.json が古い")
  }
  if (!existsSync(envPath) || readFileSync(envPath, "utf8") !== env) {
    problems.push(".env.example が古い")
  }
  if (problems.length > 0) {
    for (const p of problems) console.log(`  NG: ${p}`)
    console.log("  直し方: bash scripts/build-config-expected.sh")
    process.exit(1)
  }
  console.log("  OK: 生成物は最新")
  process.exit(0)
}

writeFileSync(jsonPath, json)
writeFileSync(envPath, env)
console.log(`書き出した: docs/agents/config-expected.json（表 ${expected.tableGrants.length} / 関数 ${expected.functionGrants.length} / ポリシー ${expected.policies.length}）`)
console.log(`書き出した: .env.example（${expected.envNames.length} 変数）`)
' "$REPO_ROOT" "$MODE"
