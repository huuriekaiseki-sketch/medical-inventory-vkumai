// WHY: issue #757 の 20。2026-09-07 に見つけた実害 8 件は、ほぼすべて**層の間の食い違い**だった。
//      API が DB より緩い（数量 0 を通す）、API が DB より厳しい（備考 500 対 1,000）、
//      型の必須項目を API が見ていない、設定に無い値が DB にある。
//      「作る段階で 4 層を揃える」を人の注意力に任せると同じことが起きるので、
//      DB 側の条件を機械で列挙し、API 側（zod）と突き合わせられる形にする。
//
// 拾う条件（DB が実際に守っているもの）:
//   maxLength … length(col) <= N
//   min       … col >= N / col > N
//   enum      … col IN ('a','b')
//
// 使い方: node scripts/lib/scan-db-constraints.mjs <migrations ディレクトリ>
//   出力は JSON（{ "table.column": [{ kind, value }] }）。

import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node scripts/lib/scan-db-constraints.mjs <migrations dir>')
  process.exit(2)
}

const strip = (sql) =>
  sql
    .replace(/\$([a-zA-Z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')

/** "table.column" -> [{ kind, value }] */
const constraints = new Map()
const add = (table, column, entry) => {
  const key = `${table.toLowerCase()}.${column.toLowerCase()}`
  const list = constraints.get(key) ?? []
  // 同じ種類は後から来たほうで上書きする（migration は適用順に読むため）
  const rest = list.filter((e) => e.kind !== entry.kind)
  rest.push(entry)
  constraints.set(key, rest)
}

/** CHECK の中身から条件を拾う。table が分からない場合は null を渡す */
function harvest(body, table, fallbackTables) {
  const target = (col) => table ?? fallbackTables.get(col.toLowerCase()) ?? null

  for (const m of body.matchAll(/(?:char_)?length\s*\(\s*"?([a-z_][a-z0-9_]*)"?\s*\)\s*<=\s*(\d+)/gi)) {
    const t = target(m[1])
    if (t) add(t, m[1], { kind: 'maxLength', value: Number(m[2]) })
  }
  for (const m of body.matchAll(/"?([a-z_][a-z0-9_]*)"?\s*>=\s*(\d+)/gi)) {
    const t = target(m[1])
    if (t) add(t, m[1], { kind: 'min', value: Number(m[2]) })
  }
  for (const m of body.matchAll(/"?([a-z_][a-z0-9_]*)"?\s*>\s*(\d+)(?!=)/gi)) {
    const t = target(m[1])
    if (t) add(t, m[1], { kind: 'min', value: Number(m[2]) + 1 })
  }
  for (const m of body.matchAll(/"?([a-z_][a-z0-9_]*)"?\s+in\s*\(([^)]*)\)/gi)) {
    const t = target(m[1])
    if (!t) continue
    const values = [...m[2].matchAll(/'([^']*)'/g)].map((v) => v[1])
    if (values.length > 0) add(t, m[1], { kind: 'enum', value: values })
  }
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

// CREATE TABLE の中のインライン CHECK は表名が構文から取れないので、列名 → 表名の索引を先に作る
const columnToTable = new Map()
for (const f of files) {
  const sql = strip(fs.readFileSync(path.join(dir, f), 'utf8'))
  for (const m of sql.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?"?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\n\)/gi
  )) {
    const table = m[1].toLowerCase()
    for (const line of m[2].split('\n')) {
      const c = line.trim().match(/^"?([a-z_][a-z0-9_]*)"?\s+[a-z]/i)
      if (c) columnToTable.set(c[1].toLowerCase(), table)
    }
  }
}

for (const f of files) {
  const sql = strip(fs.readFileSync(path.join(dir, f), 'utf8'))

  // ALTER TABLE ... CHECK ( ... )
  for (const m of sql.matchAll(
    /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?"?(?:public\.)?"?([a-z_][a-z0-9_]*)"?[\s\S]{0,150}?check\s*\(([\s\S]*?)\)\s*(?:not\s+valid)?\s*;/gi
  )) {
    harvest(m[2], m[1].toLowerCase(), columnToTable)
  }

  // CREATE TABLE 内のインライン CHECK
  for (const m of sql.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?"?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\n\)/gi
  )) {
    const table = m[1].toLowerCase()
    for (const c of m[2].matchAll(/check\s*\(([^;]*?)\)\s*(?:,|\n)/gi)) {
      harvest(c[1], table, columnToTable)
    }
  }
}

const out = {}
for (const key of [...constraints.keys()].sort()) out[key] = constraints.get(key)
console.log(JSON.stringify(out, null, 2))
