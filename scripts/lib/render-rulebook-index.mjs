#!/usr/bin/env node
// ルールブックの索引（docs/agents/rulebooks.md）を登録簿から生成する。
//
// WHY: ルールブックが 2 つのうちは覚えていられるが、10 を超えると「どれを開けばいいか」が
//      分からなくなる。かといって索引を手で書くと、増やしたのに索引に足し忘れる・消したのに
//      残る、が必ず起きる（このリポジトリで docs のリンク切れが繰り返し出た型）。
//      索引は登録簿から**生成**し、生成物が最新かを検査する（プラグイン生成と同じ形）。
//
// 使い方:
//   node scripts/lib/render-rulebook-index.mjs <registry.json> --out <index.md> [--root <repo>]
//   node scripts/lib/render-rulebook-index.mjs <registry.json> --out <index.md> --check
//
// --check: 書き込まず、既存の索引と一致するかだけ見る（一致すれば exit 0、違えば 1）

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const o = { root: process.cwd(), check: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') o.out = argv[++i]
    else if (a === '--root') o.root = argv[++i]
    else if (a === '--check') o.check = true
    else o.registry = a
  }
  return o
}

/** 文書の 1 行目（# 見出し）と、本文の最初の段落を取り出す */
function readSummary(abs) {
  if (!existsSync(abs)) return { title: null, lead: null }
  const lines = readFileSync(abs, 'utf8').split('\n')
  const title = (lines.find((l) => l.startsWith('# ')) ?? '').replace(/^#\s*/, '').trim() || null
  const start = lines.findIndex((l) => l.startsWith('# '))
  const lead = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l) { if (lead.length > 0) break; continue }
    if (l.startsWith('#')) break
    lead.push(l)
  }
  return { title, lead: lead.join('') || null }
}

export function renderIndex({ registry, root }) {
  const rows = []
  for (const c of registry.catalogs ?? []) {
    const abs = path.join(root, c.file)
    const { title, lead } = readSummary(abs)
    // 1 行に収まるよう、先頭の文（。まで）だけを使う
    const oneLine = (lead ?? '').split('。')[0]
    const purpose = (c.purpose ?? (oneLine ? oneLine + '。' : '（説明なし）')).replace(/\|/g, '／')
    rows.push({
      id: c.id,
      file: c.file,
      title: (title ?? c.id).replace(/\|/g, '／'),
      prefix: `${c.idPrefix}-xxx`,
      states: (c.states ?? []).join(' / ').replace(/\|/g, '／'),
      purpose,
    })
  }
  rows.sort((a, b) => a.prefix.localeCompare(b.prefix))

  const lines = []
  lines.push('# ルールブックの索引')
  lines.push('')
  lines.push('**このファイルは生成物。手で編集しない。** 正本は `scripts/lib/catalog-registry.json` と')
  lines.push('各ルールブックの本文で、`bash scripts/render-rulebook-index.sh` で作り直す。')
  lines.push('最新かどうかは `scripts/check-catalogs.test.sh`（CI `hooks-test`）が検査する。')
  lines.push('')
  lines.push('ルールブックは「守るべきことを 1 行 1 件で並べ、状態の語彙を固定し、機械が形を検査する表」。')
  lines.push('新しく作るときは `bash scripts/new-rulebook.sh`（雛形と登録を同時に作り、その場で検査まで回す）。')
  lines.push('')
  lines.push('| ID 帯 | ルールブック | 何を並べるか | 状態の語彙 |')
  lines.push('| --- | --- | --- | --- |')
  for (const r of rows) {
    lines.push(`| \`${r.prefix}\` | [${r.title}](${path.posix.basename(r.file)}) | ${r.purpose} | ${r.states} |`)
  }
  lines.push('')
  lines.push(`（${rows.length} 件）`)
  lines.push('')
  return lines.join('\n')
}

const o = parseArgs(process.argv.slice(2))
if (!o.registry || !o.out) {
  console.error('使い方: node scripts/lib/render-rulebook-index.mjs <registry.json> --out <index.md> [--check]')
  process.exit(2)
}
const registry = JSON.parse(readFileSync(o.registry, 'utf8'))
const rendered = renderIndex({ registry, root: o.root })
const outAbs = path.isAbsolute(o.out) ? o.out : path.join(o.root, o.out)

if (o.check) {
  const current = existsSync(outAbs) ? readFileSync(outAbs, 'utf8') : ''
  if (current === rendered) {
    console.log('rulebook index: 最新')
    process.exit(0)
  }
  console.error('rulebook index: 生成物と一致しない（bash scripts/render-rulebook-index.sh で作り直す）')
  process.exit(1)
}
writeFileSync(outAbs, rendered)
console.log(`書き出した: ${o.out}`)
