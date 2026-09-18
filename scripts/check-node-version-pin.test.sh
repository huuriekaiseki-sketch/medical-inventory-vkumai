#!/usr/bin/env bash
# WHY: issue #775。**lock を生成する道具の版が誰にも固定されていなかった。**
#
#      2026-09-18 に起きたこと: CI の全ジョブが冒頭の `npm ci` で落ちた。
#      `@tailwindcss/oxide-wasm32-wasi` の bundleDependencies のうち 2 つの lock エントリが
#      欠けていたが、**手元の npm 11.6.2 は「lock は最新」と言い、CI の npm 11.19.0 だけが落とした**。
#      原因は CI が `node-version: '24'`（浮動）で、Node のパッチ更新とともに同梱 npm が動くこと。
#
#      正本は `.nvmrc`（Node の厳密な版）。同梱 npm が決まるので npm も自動的に揃う。
#      package.json の engines は**宣言**で、ここと食い違ったら落とす。
#
# 見るもの:
#   (a) .nvmrc が厳密な版（x.y.z）である。メジャーだけ・範囲は不可
#   (b) package.json の engines.node が .nvmrc と一致する
#   (c) **すべての workflow が node-version-file: '.nvmrc' を使う**（浮動の node-version を書かない）
#
# 見ないもの（限界）:
#   - engines.npm が実際にその Node に同梱される npm かは**機械で確かめていない**
#     （版の対応表を持たないため）。Node を上げたら手で直す。食い違えば CI の npm ci が落ちるので、
#     黙って通ることは無い
#   - engine-strict は入れていない。手元の npm が違っても止まらない（Node を上げれば揃う前提）
#
# 実行: bash scripts/check-node-version-pin.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY(導入先の木を見る、2026-09-18 実測): スクリプトの位置から決め打ちにすると、
#      **空の木で回されても自分のリポジトリを見て黙って通る**（配布の網羅検査が捕まえた）。
#      他の「both」検査と同じく CLAUDE_PROJECT_DIR を優先する。
REPO_ROOT="${NODE_VERSION_PIN_ROOT:-${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}}"

command -v node >/dev/null 2>&1 || {
  echo "=== scenario 0: 実行系が足りない ==="
  echo "  SKIP: node が無いので確認不能（合格にも違反にも数えない）"
  echo "ALL PASSED"
  exit 0
}
if [ ! -f "$REPO_ROOT/package.json" ] || [ ! -d "$REPO_ROOT/.github/workflows" ]; then
  echo "=== scenario 0: この導入先には対象が無い ==="
  echo "  SKIP: package.json か .github/workflows が無いので対象なし"
  echo "ALL PASSED"
  exit 0
fi

node --input-type=module -e '
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = process.argv[1]
let fail = 0
const ok = (m) => console.log(`  OK: ${m}`)
const ng = (m, d) => { console.log(`  NG: ${m}`); if (d) console.log(`      ${d}`); fail = 1 }

/** 1 つの木を見て、違反の配列を返す（fixture でも実物でも同じ判定を使う） */
function inspect(dir) {
  const problems = []
  const nvmrcPath = path.join(dir, ".nvmrc")
  if (!existsSync(nvmrcPath)) {
    problems.push(".nvmrc が無い（Node の版の正本が決まっていない）")
    return problems
  }
  const nvmrc = readFileSync(nvmrcPath, "utf8").trim()
  if (!/^\d+\.\d+\.\d+$/.test(nvmrc)) {
    problems.push(`.nvmrc が厳密な版でない: "${nvmrc}"（x.y.z で書く。メジャーだけだと npm の版まで動く）`)
  }

  const pkgPath = path.join(dir, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  const declared = pkg.engines?.node
  if (!declared) {
    problems.push("package.json の engines.node が無い")
  } else if (declared !== nvmrc) {
    problems.push(`engines.node（${declared}）と .nvmrc（${nvmrc}）が食い違う`)
  }
  if (!pkg.engines?.npm) {
    problems.push("package.json の engines.npm が無い（lock を生成した npm の版を残す）")
  }

  const wfDir = path.join(dir, ".github/workflows")
  if (!existsSync(wfDir)) return problems
  for (const f of readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x))) {
    const text = readFileSync(path.join(wfDir, f), "utf8")
    if (!/actions\/setup-node/.test(text)) continue
    // コメントを除いた行だけを見る（説明文に node-version と書いてあるのを拾わない）
    const lines = text.split("\n").map((l) => l.replace(/#.*$/, ""))
    for (const [i, line] of lines.entries()) {
      if (/^\s*node-version\s*:/.test(line)) {
        problems.push(`${f}:${i + 1} 浮動の node-version がある（node-version-file: ".nvmrc" にする）`)
      }
    }
    if (!/node-version-file\s*:\s*["\x27]\.nvmrc["\x27]/.test(text)) {
      problems.push(`${f} が setup-node を使うのに node-version-file: ".nvmrc" を指していない`)
    }
  }
  return problems
}

console.log("=== scenario 1: 実態の固定に違反が無い ===")
{
  const problems = inspect(root)
  if (problems.length === 0) ok("`.nvmrc` / engines / workflow が揃っている")
  else for (const p of problems) ng(p)
}

console.log("=== scenario 2: fixture で検知できる（RED 方向の自己検証） ===")
{
  const work = mkdtempSync(path.join(tmpdir(), "node-pin-"))
  const wf = path.join(work, ".github/workflows")
  mkdirSync(wf, { recursive: true })
  const put = (rel, body) => writeFileSync(path.join(work, rel), body)
  const good = () => {
    writeFileSync(path.join(work, ".nvmrc"), "24.20.0\n")
    put("package.json", JSON.stringify({ engines: { node: "24.20.0", npm: "11.19.0" } }))
    writeFileSync(path.join(wf, "a.yml"), "      - uses: actions/setup-node@v7\n        with:\n          node-version-file: \x27.nvmrc\x27\n")
  }
  const has = (problems, needle, label) =>
    problems.some((p) => p.includes(needle)) ? ok(label) : ng(label, JSON.stringify(problems))

  good()
  if (inspect(work).length === 0) ok("正しい fixture は 1 件も出さない（対照）")
  else ng("正しい fixture で違反を出した", JSON.stringify(inspect(work)))

  good()
  writeFileSync(path.join(work, ".nvmrc"), "24\n")
  has(inspect(work), "厳密な版でない", "メジャーだけの .nvmrc を検知")

  good()
  put("package.json", JSON.stringify({ engines: { node: "24.19.0", npm: "11.19.0" } }))
  has(inspect(work), "食い違う", "engines.node と .nvmrc の食い違いを検知")

  good()
  put("package.json", JSON.stringify({ engines: { node: "24.20.0" } }))
  has(inspect(work), "engines.npm が無い", "engines.npm の書き忘れを検知")

  good()
  writeFileSync(path.join(wf, "a.yml"), "      - uses: actions/setup-node@v7\n        with:\n          node-version: \x2724\x27\n")
  has(inspect(work), "浮動の node-version", "workflow の浮動指定を検知")

  good()
  writeFileSync(path.join(wf, "a.yml"), "      - uses: actions/setup-node@v7\n        with:\n          cache: \x27npm\x27\n")
  has(inspect(work), "指していない", "setup-node を使うのに .nvmrc を指していないのを検知")

  good()
  writeFileSync(path.join(wf, "a.yml"), "      - uses: actions/setup-node@v7\n        with:\n          # node-version: \x2724\x27 は使わない\n          node-version-file: \x27.nvmrc\x27\n")
  if (inspect(work).length === 0) ok("コメント内の node-version は誤検知しない")
  else ng("コメントを拾った", JSON.stringify(inspect(work)))

  rmSync(work, { recursive: true, force: true })
}

if (fail !== 0) { console.log("FAILED"); process.exit(1) }
console.log("ALL PASSED")
' "$REPO_ROOT"
