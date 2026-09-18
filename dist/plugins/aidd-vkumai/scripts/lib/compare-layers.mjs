// WHY: issue #757 の 20。DB（migration の CHECK）と API（zod スキーマ）の条件を
//      **値まで**突き合わせる。どちらも実物から自動抽出したものを受け取り、
//      対応付けは命名規約（snake_case → camelCase）で導く。
//
//      Codex の指摘「対応表を手で書くこと自体がズレの発生源になる」への答え:
//      人が書くのは規約から外れるものだけにして、手作業の面を最小にする。
//
// 使い方: node scripts/lib/compare-layers.mjs <migrations> <api-rules.json> <layer-map.json>
//   食い違いを 1 行ずつ標準出力に書く。何も出なければ一致。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { writeLine } from './stdout-sync.mjs'

const [migrations, apiJsonPath, mapPath] = process.argv.slice(2)
if (!migrations || !apiJsonPath || !mapPath) {
  console.error('usage: node scripts/lib/compare-layers.mjs <migrations> <api-rules.json> <layer-map.json>')
  process.exit(2)
}

const here = path.dirname(new URL(import.meta.url).pathname)
const db = JSON.parse(
  execFileSync(process.execPath, [path.join(here, 'scan-db-constraints.mjs'), migrations], { encoding: 'utf8' })
)
const api = JSON.parse(fs.readFileSync(apiJsonPath, 'utf8'))
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'))
const tables = map.tables ?? {}
const columns = map.columns ?? {}

const problems = []
const say = (kind, col, detail) => problems.push(`${kind} ${col}${detail ? ' — ' + detail : ''}`)

/** snake_case → camelCase */
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())

/** 対応付けの候補を返す（規約 → 対応表の順） */
function resolve(col) {
  const rule = columns[col]
  if (rule?.serverOnly) return { kind: 'serverOnly' }
  if (rule?.exception) return { kind: 'exception', rule }
  if (rule?.api) return { kind: 'api', target: rule.api }

  const [table, column] = col.split('.')
  const schema = tables[table]
  if (!schema) return { kind: 'unmapped-table', table }
  return { kind: 'api', target: `${schema}.${camel(column)}`, derived: true }
}

const seenTargets = new Set()

for (const [col, entries] of Object.entries(db)) {
  const r = resolve(col)

  if (r.kind === 'serverOnly') continue

  if (r.kind === 'exception') {
    if (!r.rule.until) {
      say('no-expiry', col, '例外には until（YYYY-MM-DD）が要る')
    } else {
      const until = new Date(r.rule.until)
      if (Number.isNaN(until.getTime())) say('bad-expiry', col, `until が日付として読めない（${r.rule.until}）`)
      else if (Date.now() > until.getTime()) say('expired', col, `例外の期限 ${r.rule.until} を過ぎた`)
    }
    continue
  }

  if (r.kind === 'unmapped-table') {
    say('unmapped', col, `表 ${r.table} に対応するスキーマが分からない。layer-map.json の tables に足すか、列を serverOnly にする`)
    continue
  }

  const rule = api[r.target]
  seenTargets.add(r.target)
  if (!rule) {
    say('missing-api', col, `${r.target} が API に無い（DB は守っているのに入口が素通り）`)
    continue
  }

  for (const e of entries) {
    if (e.kind === 'maxLength') {
      if (rule.maxLength === null) say('missing-rule', col, `${r.target} に長さの上限が無い（DB は ${e.value}）`)
      else if (rule.maxLength !== e.value) say('value-mismatch', col, `長さ DB ${e.value} / API ${rule.maxLength}（${r.target}）`)
    }
    if (e.kind === 'min') {
      if (rule.min === null) say('missing-rule', col, `${r.target} に下限が無い（DB は ${e.value} 以上）`)
      else if (rule.min !== e.value) say('value-mismatch', col, `下限 DB ${e.value} / API ${rule.min}（${r.target}）`)
    }
    if (e.kind === 'enum') {
      const dbSet = [...e.value].sort().join(',')
      const apiSet = rule.enum ? [...rule.enum].sort().join(',') : null
      if (apiSet === null) say('missing-rule', col, `${r.target} に固定語の制限が無い（DB は ${dbSet}）`)
      else if (apiSet !== dbSet) say('value-mismatch', col, `固定語 DB [${dbSet}] / API [${apiSet}]（${r.target}）`)
    }
  }
}

// 対応表の陳腐化（DB に無い列を指している）
for (const col of Object.keys(columns)) {
  if (!db[col]) say('stale', col, 'DB に CHECK が無い。CHECK を消したなら対応表からも消す')
}

for (const line of problems) writeLine(line)
process.exit(problems.length > 0 ? 1 : 0)
