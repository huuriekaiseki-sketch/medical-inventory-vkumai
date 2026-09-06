#!/usr/bin/env node
// ルールブック（カタログ）の形を検査する汎用エンジン。
//
// WHY: 2026-09-06〜07 の 1 週間で、同じ形のルールブックを 8 つ書いた（約束・不変条件・脅威・
//      fail-open・データの残存先・人間系の回避・アクセス経路・部分成功・到達範囲）。そのたびに
//      「列数・ID の形・重複・状態の語彙・守るテストの実在・未着手なら issue 番号」を検査する
//      bash を 150 行ずつ書き写していた。写すたびに少しずつ違う（ある検査は重複 ID を見ない、
//      別の検査はパスの実在を見ない）ので、**ルールブックが増えるほど検査の質がばらつく**。
//
//      検査の中身は全部同じなので、エンジンを 1 本にして、違うところ（列名・ID の接頭辞・
//      状態の語彙）だけを登録簿（catalog-registry.json）に書く形にする。
//      新しいルールブックを足すときに書くのは登録簿の 1 エントリと文書だけで、検査は書かない。
//
// 使い方:
//   node scripts/lib/check-catalog.mjs <registry.json> [--root <repo>] [--only <id>]
//   node scripts/lib/check-catalog.mjs --spec '<json>' --file <path> [--root <repo>]
//
// 出力: 違反を 1 行ずつ stdout に出し、最後に `violations=N`。exit code は常に 0
//       （呼び出し側の *.test.sh が件数を見て判定する）。
//
// 登録簿 1 エントリの形:
//   {
//     "id": "invariant",                       // 表示名
//     "file": "docs/agents/invariant-catalog.md",
//     "idPrefix": "I",                         // ID は I-3桁
//     "columns": 7,                            // 列数（区切り `|` の数 - 1）
//     "evidenceColumn": 6,                     // 1 始まり。守るテスト列。省略時は検査しない
//     "statusColumn": 7,                       // 1 始まり。状態列
//     "states": ["実装済み", "計画", "対象外"], // 状態の語彙（前方一致で見る）
//     "evidenceRequiredStates": ["実装済み"],   // この状態なら守るテストにパスが要る
//     "planRequiredStates": ["計画"],           // この状態なら #757-N のような計画番号が要る
//     "planPattern": "#757-[0-9]+",            // 省略時は planRequiredStates を検査しない
//     "idBands": [10, 20, 30]                  // 省略可。区分の先頭（10 刻み）。書けば帯の外を違反にする
//   }

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/** 表の行（`| A | B |`）を列の配列にする。前後の空文字は落とす */
export function splitRow(line) {
  const cells = line.split('|')
  // 先頭と末尾は `|` の外側の空文字
  return cells.slice(1, -1).map((c) => c.trim())
}

/**
 * 1 つのルールブックを検査する。
 * @param {{spec: object, text: string, root: string}} input
 * @returns {string[]} 違反の説明（0 件なら空配列）
 */
export function checkCatalog({ spec, text, root }) {
  const violations = []
  const prefix = spec.idPrefix
  const idRe = new RegExp(`^${prefix}-[0-9]{3}$`)
  const rowRe = new RegExp(`^\\|\\s*${prefix}-`)
  const seen = new Set()
  const rows = text.split('\n').filter((l) => rowRe.test(l))

  if (rows.length === 0) violations.push(`${spec.id}: 行が 1 つも無い（${prefix}-xxx の行）`)

  for (const line of rows) {
    const cells = splitRow(line)
    const id = cells[0] ?? ''

    if (cells.length !== spec.columns) {
      violations.push(`${spec.id}: columns: [${id}] 列数が ${spec.columns} でない（${cells.length}）`)
      continue
    }
    if (!idRe.test(id)) {
      violations.push(`${spec.id}: id: [${id}] ID が ${prefix}-3桁でない`)
    }
    if (seen.has(id)) violations.push(`${spec.id}: id: [${id}] ID が重複`)
    seen.add(id)

    if (Array.isArray(spec.idBands) && spec.idBands.length > 0 && idRe.test(id)) {
      const n = Number(id.slice(prefix.length + 1))
      const band = Math.floor(n / 10) * 10
      if (!spec.idBands.includes(band)) {
        violations.push(`${spec.id}: band: [${id}] 区分の番号帯（${spec.idBands.join(' / ')}）の外`)
      }
    }

    const status = cells[(spec.statusColumn ?? spec.columns) - 1] ?? ''
    const known = (spec.states ?? []).find((st) => status === st || status.startsWith(st))
    if (!known) {
      violations.push(`${spec.id}: status: [${id}] 状態が語彙にない: '${status}'`)
      continue
    }

    if ((spec.planRequiredStates ?? []).includes(known) && spec.planPattern) {
      if (!new RegExp(spec.planPattern).test(status)) {
        violations.push(`${spec.id}: plan: [${id}] ${known} なのに計画番号（${spec.planPattern}）が無い`)
      }
    }

    if (spec.evidenceColumn) {
      const evidence = cells[spec.evidenceColumn - 1] ?? ''
      const paths = [...evidence.matchAll(/`([^`]+)`/g)].map((m) => m[1])
      if ((spec.evidenceRequiredStates ?? []).includes(known) && paths.length === 0) {
        violations.push(`${spec.id}: evidence: [${id}] ${known} なのに守るテストが無い`)
      }
      for (const p of paths) {
        // 拡張子を持つものだけをパスとして実在検査する（説明文のバッククォートを誤検知しない）
        if (!/\.(ts|tsx|mjs|js|sh|sql|md|json|yml|yaml)$/.test(p)) continue
        if (!existsSync(path.join(root, p))) {
          violations.push(`${spec.id}: path: [${id}] 守るテストのパスが存在しない: ${p}`)
        }
      }
    }
  }
  return violations
}

function main(argv) {
  let root = process.cwd()
  let registryPath = null
  let specJson = null
  let filePath = null
  let only = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') root = argv[++i]
    else if (a === '--spec') specJson = argv[++i]
    else if (a === '--file') filePath = argv[++i]
    else if (a === '--only') only = argv[++i]
    else registryPath = a
  }

  const specs = []
  if (specJson) {
    const spec = JSON.parse(specJson)
    specs.push({ spec, file: filePath ?? spec.file })
  } else if (registryPath) {
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
    for (const spec of registry.catalogs ?? []) {
      if (only && spec.id !== only) continue
      specs.push({ spec, file: spec.file })
    }
  } else {
    console.log('registry か --spec のどちらかが要る')
    console.log('violations=1')
    return
  }

  let total = 0
  for (const { spec, file } of specs) {
    const abs = path.isAbsolute(file) ? file : path.join(root, file)
    if (!existsSync(abs)) {
      console.log(`${spec.id}: ファイルが無い: ${file}`)
      total += 1
      continue
    }
    const found = checkCatalog({ spec, text: readFileSync(abs, 'utf8'), root })
    for (const v of found) console.log(v)
    total += found.length
  }
  console.log(`violations=${total}`)
}

// 直接実行されたときだけ走らせる（テストからは import して使う）
if (process.argv[1] && process.argv[1].endsWith('check-catalog.mjs')) {
  main(process.argv.slice(2))
}
