#!/usr/bin/env node
// WHY: 2026-09-15。ハーネスの成績（止めた / 見逃した / 邪魔した）は、それまで docs/sessions の文章に
//      人が書いていた。文章はリポジトリをまたいで集められないし、「どの部品が・どの層で」が抜けると
//      ある導入先の都合で共通側を削ってしまう。1 件 1 行の機械可読な形にし、語彙と必須項目を固定する。
//
//      **エンジンは共通・記録は各リポジトリのもの。** 記録は `docs/agents/harness-score.jsonl`
//      （git で追跡する。`logs/` は機械ローカルなので、リポジトリをまたいで集める用途に使えない）。
//      v1.x の「残す / 直す / 削る」は、この記録を層で分けて読む（`--summary`）。
//
// 既知の限界:
//   - 行の中身が本当に起きたことかは見ない（自己申告）。見るのは形と語彙と参照先の実在だけ。
//   - 「止めた」の重さは数えない（1 件のバグを止めたのも、1 件の誤パスを止めたのも 1 行）。
//   - 費用は任意項目。書かれていなければ「邪魔した」の重さが読めない。
//   - 部品名（component）は自由記述。同じ部品を別名で書けば別の部品として数える。

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { writeLine } from './stdout-sync.mjs'

export const SCORE_FILE = 'docs/agents/harness-score.jsonl'
export const LAYERS = ['core', 'adapter', 'consumer']
export const VERDICTS = ['stopped', 'missed', 'obstructed']
export const REQUIRED = ['date', 'repo', 'issue', 'component', 'layer', 'verdict', 'detail', 'ref']
const COST_KEYS = ['minutes', 'tokens', 'agents', 'usd']

/** JSONL を行ごとに読む。壊れた行は落とさず、行番号つきの誤りとして返す */
export function parseScore(text) {
  const rows = []
  const errors = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (!line.trim()) return
    try {
      const row = JSON.parse(line)
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        errors.push(`line ${i + 1}: オブジェクトでない`)
        return
      }
      rows.push({ ...row, __line: i + 1 })
    } catch (e) {
      errors.push(`line ${i + 1}: JSON として読めない（${e.message}）`)
    }
  })
  return { rows, errors }
}

/** 形・語彙・参照先を見る。root は ref の実在を確かめる基準（省略時は確かめない） */
export function validateRows(rows, { root } = {}) {
  const errors = []
  for (const row of rows) {
    const at = `line ${row.__line ?? '?'}`
    for (const key of REQUIRED) {
      if (typeof row[key] !== 'string' || row[key].trim() === '') {
        errors.push(`${at}: ${key} が無いか空`)
      }
    }
    if (typeof row.date === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      errors.push(`${at}: date は YYYY-MM-DD（${row.date}）`)
    }
    if (typeof row.layer === 'string' && !LAYERS.includes(row.layer)) {
      errors.push(`${at}: layer は ${LAYERS.join(' / ')} のどれか（${row.layer}）`)
    }
    if (typeof row.verdict === 'string' && !VERDICTS.includes(row.verdict)) {
      errors.push(`${at}: verdict は ${VERDICTS.join(' / ')} のどれか（${row.verdict}）`)
    }
    if (row.cost !== undefined) {
      if (typeof row.cost !== 'object' || row.cost === null || Array.isArray(row.cost)) {
        errors.push(`${at}: cost はオブジェクト`)
      } else {
        for (const [k, v] of Object.entries(row.cost)) {
          if (!COST_KEYS.includes(k)) errors.push(`${at}: cost.${k} は知らない鍵（${COST_KEYS.join(' / ')}）`)
          else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) errors.push(`${at}: cost.${k} は 0 以上の数（${v}）`)
        }
      }
    }
    if (root && typeof row.ref === 'string' && row.ref && !/^https?:\/\//.test(row.ref)) {
      const target = row.ref.split('#')[0]
      if (!existsSync(path.join(root, target))) {
        errors.push(`${at}: ref の実体が無い（${target}）`)
      }
    }
  }
  return errors
}

/** 部品 × 層ごとの件数。v1.x の判断はこの表を読む */
export function summarize(rows) {
  const table = new Map()
  for (const row of rows) {
    const key = `${row.component}\t${row.layer}`
    if (!table.has(key)) {
      table.set(key, { component: row.component, layer: row.layer, stopped: 0, missed: 0, obstructed: 0, minutes: 0 })
    }
    const entry = table.get(key)
    if (VERDICTS.includes(row.verdict)) entry[row.verdict] += 1
    if (row.cost && typeof row.cost.minutes === 'number') entry.minutes += row.cost.minutes
  }
  return [...table.values()].sort((a, b) => a.layer.localeCompare(b.layer) || a.component.localeCompare(b.component))
}

/**
 * 仕分けの規則（2026-09-14 に人が決めた）:
 *   残す      … 止めた が 1 件でもある
 *   直すか外す … 止めた が無く、見逃した がある
 *   削る      … 止めた も 見逃した も無く、邪魔した だけ
 *   （止めた も 邪魔した もある部品は「残す」だが費用を見る）
 */
export function decide(entry) {
  if (entry.stopped > 0) return entry.obstructed > 0 ? 'keep(costly)' : 'keep'
  if (entry.missed > 0) return 'fix-or-drop'
  if (entry.obstructed > 0) return 'drop'
  return 'unknown'
}

function main(argv) {
  let root = process.cwd()
  let file = null
  let summary = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(argv[++i])
    else if (argv[i] === '--file') file = path.resolve(argv[++i])
    else if (argv[i] === '--summary') summary = true
  }
  const target = file ?? path.join(root, SCORE_FILE)
  if (!existsSync(target)) {
    // 対象なし。合格とも失敗とも読ませない（C-025）
    writeLine(`[harness-score] 記録が無い: ${path.relative(root, target)}（対象なし）`)
    process.exit(4)
  }
  const { rows, errors: parseErrors } = parseScore(readFileSync(target, 'utf8'))
  const errors = [...parseErrors, ...validateRows(rows, { root })]
  if (errors.length > 0) {
    for (const e of errors) writeLine(`[harness-score] NG ${e}`)
    writeLine(`[harness-score] 違反 ${errors.length} 件 / ${rows.length} 行`)
    process.exit(1)
  }
  writeLine(`[harness-score] OK ${rows.length} 行（違反なし）`)
  if (summary) {
    writeLine('layer\tcomponent\tstopped\tmissed\tobstructed\tminutes\tdecision')
    for (const e of summarize(rows)) {
      writeLine(`${e.layer}\t${e.component}\t${e.stopped}\t${e.missed}\t${e.obstructed}\t${e.minutes}\t${decide(e)}`)
    }
  }
  process.exit(0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2))
}
