#!/usr/bin/env node
// WHY: issue #757 の 14（フレーキー検知）。同じテストを N 回回した vitest の JSON レポートを突き合わせ、
//      「通ったり落ちたりする」テスト（flaky）と「毎回落ちる」テスト（本当の失敗）を分けて出す。
//      同時実行・冪等性の統合テストは実 DB で並列に走るため揺れやすく、揺れは「たまたま通った」を
//      緑と誤読させる。1 回の緑では分からないので、回数を重ねて状態の混在を機械で見る。
//
// 使い方: node scripts/lib/flaky-aggregate.mjs [--json] [--md <path>] <report.json>...
//   report.json は `vitest run --reporter=json --outputFile.json=<path>` の出力
// 終了コード: 0 = 何も無し / 1 = flaky あり / 2 = 常時失敗あり / 3 = レポートが読めない
//             4 = 環境事故のみ（テストの揺れではない。直す先は環境）
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

/** @type {Map<string, {passed:number, failed:number, messages:string[], failedRuns:number[]}>} */
const stats = new Map()
const unreadable = []
/** いま読んでいるレポートが何回目か（0 始まり）。環境事故の判定に使う */
let runIndex = -1

const bump = (key, status, message) => {
  const s = stats.get(key) ?? { passed: 0, failed: 0, messages: [], failedRuns: [] }
  if (status === 'passed') s.passed += 1
  else if (status === 'failed') {
    s.failed += 1
    s.failedRuns.push(runIndex)
    if (message && s.messages.length < 3) s.messages.push(String(message).split('\n')[0].slice(0, 200))
  }
  stats.set(key, s)
}

for (const file of reports) {
  runIndex += 1
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

// WHY(2026-09-07): 統合テストを 10 回回したら「揺れるテスト 35 件」と出たが、実際は
//      **1 回の実行でまとめて落ちた 1 件の環境事故**だった（ローカル Supabase の Auth が
//      一時的に不調になり、"Database error querying schema" 等が並んだ）。
//      35 件の独立した揺れとして報告すると、直す先を 35 個探すことになる。
//      **同じ回にだけ落ちたテストがまとまっている**なら、それは 1 つの事故として括る。
//
// 判定: 「ちょうど 1 回だけ落ちた」テストを、その回ごとに数える。
//       1 つの回に ENV_EVENT_MIN 件以上あれば、その回は環境事故とみなす。
//       件数だけで見る（メッセージの中身は環境によって変わるので当てにしない）。
//
// 既知の限界:
//   - **本当に同じ回にたまたま複数のテストが揺れた場合も、環境事故に見える。**
//     逆に、環境事故が 2 回に分かれて起きると括られない。件数の閾値でしか区別していない。
//   - 括ったからといって無視してよいわけではない。**環境が落ちたこと自体が問題**で、
//     CI なら再実行で緑になり、実運用なら利用者に見える障害になる。
const ENV_EVENT_MIN = 5
const singleRunFailures = new Map()
for (const [, st] of stats) {
  if (st.passed > 0 && st.failed === 1) {
    const r = st.failedRuns[0]
    singleRunFailures.set(r, (singleRunFailures.get(r) ?? 0) + 1)
  }
}
const envEventRuns = new Set(
  [...singleRunFailures.entries()].filter(([, n]) => n >= ENV_EVENT_MIN).map(([r]) => r),
)

const flaky = []
const envEvent = []
const alwaysFailing = []
for (const [key, s] of [...stats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const row = { test: key, passed: s.passed, failed: s.failed, messages: s.messages }
  if (s.passed > 0 && s.failed === 1 && envEventRuns.has(s.failedRuns[0])) {
    envEvent.push({ ...row, run: s.failedRuns[0] + 1 })
  } else if (s.passed > 0 && s.failed > 0) flaky.push(row)
  else if (s.failed > 0) alwaysFailing.push(row)
}

const summary = {
  runs,
  reports: reports.length,
  unreadable,
  tests: stats.size,
  flaky,
  envEvent,
  envEventRuns: [...envEventRuns].map((r) => r + 1),
  alwaysFailing,
}

// WHY(環境事故で exit 1 にしない): 直す先はテストではなく環境なので、
//      「揺れあり」として issue を作らせると 35 個の的外れな調査先ができる。
//      ただし**黙らない**（下の報告に必ず出す。exit 4 で区別できるようにする）。
const exitCode =
  unreadable.length === reports.length ? 3
  : flaky.length > 0 ? 1
  : alwaysFailing.length > 0 ? 2
  : envEvent.length > 0 ? 4
  : 0

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
lines.push(`## 環境事故とみられるもの: ${envEvent.length} 件（${envEventRuns.size} 回の実行に集中）`)
if (envEvent.length > 0) {
  lines.push('')
  lines.push(
    `**${[...envEventRuns].map((r) => `${r + 1} 回目`).join(' / ')}だけでまとめて落ちている。**` +
      'テストの揺れではなく、その実行のあいだ環境（DB・Auth・ネットワーク）が不調だった可能性が高い。' +
      '直す先はテストではなく環境。**ただし環境が落ちたこと自体は問題**で、' +
      'CI なら再実行で緑になり、実運用なら利用者に見える障害になる。',
  )
  lines.push('')
  for (const f of envEvent.slice(0, 10)) {
    lines.push(`- \`${f.test}\` — ${f.run} 回目だけ失敗`)
    for (const m of f.messages) lines.push(`  - ${m}`)
  }
  if (envEvent.length > 10) lines.push(`- …ほか ${envEvent.length - 10} 件（同じ回）`)
}
lines.push('')
lines.push(`## 毎回落ちるテスト（揺れではなくバグ）: ${alwaysFailing.length} 件`)
for (const f of alwaysFailing) {
  lines.push(`- \`${f.test}\` — failed ${f.failed} / ${runs}`)
  for (const m of f.messages) lines.push(`  - ${m}`)
}
// WHY(2026-09-07): 「揺れなし」は「揺れが無い」ではなく「**この回数では見つからなかった**」。
//      実際、同じ日に p ≈ 5〜10% で揺れるテストが 1 件あったのに、5 回の実行では 1 度も出なかった。
//      判定は passed > 0 かつ failed > 0 なので、1 回あたり p で揺れるテストを N 回で捕まえられる
//      確率は 1 - p^N - (1-p)^N。**N=3 では、コイン投げ（p=0.5）の揺れですら 25% 見逃す**
//      （N=3 の最大が 75%）。この数字を出さずに「揺れなし」とだけ書くと、
//      読み手は「揺れが無い」と受け取る（今日の「拒否 0 件」と同じ形の誤読）。
function detectionRate(p, n) {
  return 1 - p ** n - (1 - p) ** n
}
function sensitivityNote(n) {
  if (n < 2) return `実行が ${n} 回では揺れを原理的に検知できない（2 回以上が要る）`
  const best = detectionRate(0.5, n) // p=0.5 のときが最大
  const at10 = detectionRate(0.1, n)
  const at5 = detectionRate(0.05, n)
  return [
    `**${n} 回では見つからなかった**（「揺れが無い」ではない）。この回数の検知力:`,
    `最大でも ${(best * 100).toFixed(0)}%（1 回あたり 50% で揺れるテストの場合）、`,
    `10% で揺れるテストは ${(at10 * 100).toFixed(0)}%、5% なら ${(at5 * 100).toFixed(0)}% しか捕まえられない。`,
    '低い頻度の揺れを見たいなら回数を増やす（--runs）。',
  ].join('')
}

lines.push('')
lines.push(
  exitCode === 0
    ? `結果: 常時失敗なし。${sensitivityNote(runs)}`
    : exitCode === 4
      ? `結果: **環境事故が ${envEventRuns.size} 回**（テストの揺れは無し）。環境側を見る。${sensitivityNote(runs)}`
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
