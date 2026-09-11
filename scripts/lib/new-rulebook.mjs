#!/usr/bin/env node
// 新しいルールブックの雛形と登録簿エントリを作る（scripts/new-rulebook.sh から呼ばれる）。
// WHY: 表の列数・ID の帯・状態の語彙は文書と登録簿の両方に書く必要があり、手で揃えると必ずずれる。
//      1 か所の入力から両方を作る。

import { readFileSync, writeFileSync } from 'node:fs'
import { writeLine } from './stdout-sync.mjs'

function parseArgs(argv) {
  const o = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a.startsWith('--')) o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i]
  }
  return o
}

const o = parseArgs(process.argv.slice(2))
const middle = String(o.columns).split(',').map((s) => s.trim()).filter(Boolean)
const states = String(o.states).split(',').map((s) => s.trim()).filter(Boolean)
const evidenceStates = String(o.evidenceStates ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const planStates = String(o.planStates ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const header = ['ID', ...middle, '状態']
const columns = header.length
// 守るテスト列は「守るテスト」という名前の列。無ければ検査しない
const evidenceIdx = header.findIndex((h) => h.includes('守るテスト'))
const evidenceColumn = evidenceIdx >= 0 ? evidenceIdx + 1 : undefined

const sep = header.map(() => '---')
const exampleRow = (n, status, evidence) =>
  ['|', `${o.prefix}-${String(n).padStart(3, '0')}`, ...middle.map((h) => (h.includes('守るテスト') ? evidence : `（${h}）`)), status, '|'].join(' | ').replace('| | ', '| ').replace(' | |', ' |')

const planExample = planStates[0] ? `${planStates[0]}（#${o.issue}-99）` : states[states.length - 1]
const evidenceExample = evidenceStates[0] ?? states[0]

const doc = `# ${o.title}（${o.prefix}-xxx）

（このルールブックが何を一覧にするか、なぜ要るかを 2〜4 行で書く。既存の他のルールブックとの
境目もここに書く: 何を扱い、何を扱わないか）

## 更新ルール

- 列は固定 ${columns} 列: ${header.join(' / ')}。列の中に \`|\` を書かない。
- ID は \`${o.prefix}-\` + 3 桁。区分ごとに 10 刻み。欠番は詰めない（過去の PR 本文が ID を参照するため）。
- 状態は ${states.length} 語のみ: ${states.join(' / ')}。
${evidenceStates.length > 0 ? `- 状態が ${evidenceStates.join(' / ')} の行は、守るテスト列にパスを書く（\`未\` は不可）。\n` : ''}${planStates.length > 0 ? `- 状態が ${planStates.join(' / ')} の行は \`#${o.issue}-N\` を必ず書く（やらない理由か、いつやるかを残す）。\n` : ''}- 形は \`scripts/lib/catalog-registry.json\` に登録し、\`scripts/check-catalogs.test.sh\`（CI \`hooks-test\`）が検査する。
- **更新の引き金**: （どういう変更があったときにこの表を見直すかを書く。書かないと腐る）

## 一覧

| ${header.join(' | ')} |
| ${sep.join(' | ')} |
${exampleRow(1, evidenceExample, '`package.json`')}
${exampleRow(2, planExample, '未')}

## 限界

（ここに、**この仕組みで見つからないこと**を書く。埋めるまで検査が落ちる。
書いておくと、取りこぼしが起きたときに「あの限界ではないか」と最初に疑える。
例: 静的検査なので実行時の値は見ない / 名前で照合するので書き方を変えると外れる /
一覧に載せ忘れた対象そのものは検知できない）

## 読み方

（この表を見た人が最初に読むべき行、いちばん危ない行、まだ埋まっていない行を書く）
`

const entry = {
  id: o.id,
  file: o.file,
  idPrefix: o.prefix,
  columns,
  ...(evidenceColumn ? { evidenceColumn } : {}),
  statusColumn: columns,
  states,
  ...(evidenceStates.length > 0 ? { evidenceRequiredStates: evidenceStates } : {}),
  ...(planStates.length > 0 ? { planRequiredStates: planStates, planPattern: `#${o.issue}-[0-9]+` } : {}),
  // 索引に出す 1 行。埋めるまで検査が落ちる（事故のとき最初に開くのは索引なので、ここが要）
  limits: '（ここに、この仕組みで見つからないことを 1 行で書く）',
}

if (o.dryRun) {
  writeLine('--- ' + o.file + ' ---')
  writeLine(doc)
  writeLine('--- 登録簿へ足すエントリ ---')
  writeLine(JSON.stringify(entry, null, 2))
} else {
  writeFileSync(o.abs, doc)
  const registry = JSON.parse(readFileSync(o.registry, 'utf8'))
  registry.catalogs = registry.catalogs ?? []
  if (registry.catalogs.some((c) => c.id === o.id)) {
    console.error(`new-rulebook: 登録簿にすでに ${o.id} がある`)
    process.exit(2)
  }
  registry.catalogs.push(entry)
  writeFileSync(o.registry, JSON.stringify(registry, null, 2) + '\n')
  writeLine(`作った: ${o.file}`)
  writeLine(`登録した: ${o.id}（${columns} 列 / ${o.prefix}-xxx / 状態 ${states.length} 語）`)
}
