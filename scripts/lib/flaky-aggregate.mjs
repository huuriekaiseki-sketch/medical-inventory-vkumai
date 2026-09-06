#!/usr/bin/env node
// WHY: issue #757 の 14（フレーキー検知）。同じテストを N 回回した vitest の JSON レポートを突き合わせ、
//      「通ったり落ちたりする」テスト（flaky）と「毎回落ちる」テスト（本当の失敗）を分けて出す。
//      同時実行・冪等性の統合テストは実 DB で並列に走るため揺れやすく、揺れは「たまたま通った」を
//      緑と誤読させる。1 回の緑では分からないので、回数を重ねて状態の混在を機械で見る。
//
// 使い方: node scripts/lib/flaky-aggregate.mjs [--json] [--md <path>] <report.json>...
//   report.json は `vitest run --reporter=json --outputFile.json=<path>` の出力
// 終了コード: 0 = 揺れも常時失敗も無し / 1 = flaky あり / 2 = flaky は無いが常時失敗あり / 3 = レポートが読めない
//
// 判定: テストの鍵は「ファイル（cwd 相対）> フルネーム」。skipped / todo は数えない。
//   flaky        = passed > 0 かつ failed > 0
//   alwaysFailing = failed > 0 かつ passed == 0（毎回落ちる = 揺れではなくバグ）
//   ファイル自体が読み込めず落ちた run（assertionResults が空で status failed）はファイル名を鍵にする

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
let asJson = false
let mdPath = null
const reports = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') asJson = true
  else if (args[i] === '--md') mdPath = args[++i]
  else reports.push(args[i])
}

if (reports.length === 0) {
  console.error('usage: flaky-aggregate.mjs [--json] [--md <path>] <report.json>...')
  process.exit(3)
}

const cwd = process.cwd()
const rel = (p) => (path.isAbsolute(p) ? path.relative(cwd, p) : p)

/** @type {Map<string, {passed:number, failed:number, messages:string[]}>} */
const stats = new Map()
const unreadable = []

const bump = (key, status, message) => {
  const s = stats.get(key) ?? { passed: 0, failed: 0, messages: [] }
  if (status === 'passed') s.passed += 1
  else if (status === 'failed') {
    s.failed += 1
    if (message && s.messages.length < 3) s.messages.push(String(message).split('\n')[0].slice(0, 200))
  }
  stats.set(key, s)
}

for (const file of reports) {
  let report
  try {
    report = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    unreadable.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
    continue
  }
  for (const suite of report.testResults ?? []) {
    const fileKey = rel(suite.name ?? '(unknown file)')
    const results = suite.assertionResults ?? []
    if (results.length === 0 && suite.status === 'failed') {
      bump(`${fileKey} > (ファイル全体)`, 'failed', suite.message)
      continue
    }
    for (const r of results) {
      const status = r.status === 'passed' ? 'passed' : r.status === 'failed' ? 'failed' : 'other'
      if (status === 'other') continue
      bump(`${fileKey} > ${r.fullName ?? r.title}`, status, (r.failureMessages ?? [])[0])
    }
  }
}

const runs = reports.length - unreadable.length
const flaky = []
const alwaysFailing = []
for (const [key, s] of [...stats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (s.passed > 0 && s.failed > 0) flaky.push({ test: key, passed: s.passed, failed: s.failed, messages: s.messages })
  else if (s.failed > 0) alwaysFailing.push({ test: key, passed: s.passed, failed: s.failed, messages: s.messages })
}

const summary = {
  runs,
  reports: reports.length,
  unreadable,
  tests: stats.size,
  flaky,
  alwaysFailing,
}

const exitCode = unreadable.length === reports.length ? 3 : flaky.length > 0 ? 1 : alwaysFailing.length > 0 ? 2 : 0

const lines = []
lines.push(`# フレーキー検知（${runs} 回実行、${stats.size} テスト）`)
lines.push('')
if (unreadable.length > 0) {
  lines.push(`## 読めなかったレポート（${unreadable.length}）`)
  for (const u of unreadable) lines.push(`- ${u}`)
  lines.push('')
}
lines.push(`## 揺れるテスト（flaky）: ${flaky.length} 件`)
for (const f of flaky) {
  lines.push(`- \`${f.test}\` — passed ${f.passed} / failed ${f.failed}`)
  for (const m of f.messages) lines.push(`  - ${m}`)
}
lines.push('')
lines.push(`## 毎回落ちるテスト（揺れではなくバグ）: ${alwaysFailing.length} 件`)
for (const f of alwaysFailing) {
  lines.push(`- \`${f.test}\` — failed ${f.failed} / ${runs}`)
  for (const m of f.messages) lines.push(`  - ${m}`)
}
lines.push('')
lines.push(
  exitCode === 0
    ? '結果: 揺れなし・常時失敗なし'
    : exitCode === 1
      ? '結果: 揺れあり。原因（共有 fixture・並列の順序依存・時刻依存・タイムアウト）を直すか、直すまで quarantine する'
      : exitCode === 2
        ? '結果: 常時失敗あり（フレーキーではない。通常の失敗として直す）'
        : '結果: レポートが 1 つも読めない（vitest 自体が起動していない）',
)
const md = lines.join('\n')

if (mdPath) writeFileSync(mdPath, md + '\n')
if (asJson) console.log(JSON.stringify(summary, null, 2))
else console.log(md)
process.exit(exitCode)
