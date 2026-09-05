// docs 内の「保留・未実装・予定」文脈で参照している issue が実はクローズ済み、を warning で知らせる
// （issue #714 の残項目）。
//
// WHY: docs/agents/ には「issue #NNN で対応予定」「#NNN 待ち」のような記述が多く、issue が閉じても
//      文面が残る。ただし docs 内の issue 参照は数百件あり、その大半は「issue #NNN で導入した」という
//      履歴の記述で、閉じているのが当然。全参照を警告すると無意味になるため、同じ行に
//      「保留 / 未実装 / 未着手 / 未対応 / 待ち / 検討中 / 着手時期未定」のいずれかが
//      ある行だけを候補にし、その issue が CLOSED なら警告する。
//
// 状態の取得は `gh issue view` に依存する（ネットワーク・認証が要る）ため、CI では
// docs-integrity-check.yml の warning-only ステップ（continue-on-error）で回し、hooks-test では
// 回さない。テストは `--states <json>` で状態を注入し gh を呼ばない。
//
// 使い方:
//   node scripts/lib/check-docs-issue-refs.mjs --list            # 候補行だけ列挙（gh を呼ばない）
//   node scripts/lib/check-docs-issue-refs.mjs                   # gh で状態を引き、CLOSED を警告。常に exit 0
//   node scripts/lib/check-docs-issue-refs.mjs --strict          # 警告があれば exit 1（ローカル確認用）
//   node scripts/lib/check-docs-issue-refs.mjs --states s.json   # {"123":"CLOSED",...} を注入（テスト用）
//   node scripts/lib/check-docs-issue-refs.mjs --root <dir> --files a.md,b.md

import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultTargets, stripFences } from './check-docs-integrity.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(__dirname, '../..')

// 「予定」（「変更予定ファイル」等）と「blocked」（このリポジトリでは AgentResult の status 値として頻出）は
// 誤検知源だったため外している（2026-09-05 の初回実行で候補 27 件中 15 件がこの 2 語由来）
export const PENDING_MARKERS = /保留|未実装|未着手|未対応|待ち|検討中|着手時期未定/

export function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, files: null, list: false, strict: false, states: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') opts.root = path.resolve(argv[++i])
    else if (a === '--files') opts.files = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--list') opts.list = true
    else if (a === '--strict') opts.strict = true
    else if (a === '--states') opts.states = path.resolve(argv[++i])
    else throw new Error(`unknown argument: ${a}`)
  }
  return opts
}

export function findCandidates(root, files) {
  const out = []
  for (const abs of files) {
    if (!existsSync(abs)) continue
    const rel = path.relative(root, abs)
    const lines = stripFences(readFileSync(abs, 'utf8')).split('\n')
    lines.forEach((line, idx) => {
      // Markdown リンクの飛び先（アンカー slug に「保留」等の語が入りうる）はマーカー判定から除外する
      const plain = line.replace(/\]\([^)]*\)/g, ']')
      if (!PENDING_MARKERS.test(plain)) return
      for (const m of plain.matchAll(/issue #(\d+)/g)) {
        out.push({ file: rel, line: idx + 1, issue: Number(m[1]), text: line.trim() })
      }
    })
  }
  return out
}

function ghState(number) {
  const r = spawnSync('gh', ['issue', 'view', String(number), '--json', 'state'], { encoding: 'utf8' })
  if (r.status !== 0) return null
  try { return JSON.parse(r.stdout).state ?? null } catch { return null }
}

export function resolveStates(numbers, injected) {
  const states = {}
  for (const n of numbers) {
    if (injected) states[n] = injected[String(n)] ?? null
    else states[n] = ghState(n)
  }
  return states
}

export function run(opts) {
  const files = opts.files ? opts.files.map(f => path.resolve(opts.root, f)) : defaultTargets(opts.root)
  const candidates = findCandidates(opts.root, files)
  if (opts.list) return { candidates, warnings: [], unresolved: [] }
  const injected = opts.states ? JSON.parse(readFileSync(opts.states, 'utf8')) : null
  const states = resolveStates([...new Set(candidates.map(c => c.issue))], injected)
  const warnings = candidates.filter(c => states[c.issue] === 'CLOSED')
  const unresolved = [...new Set(candidates.filter(c => states[c.issue] === null).map(c => c.issue))]
  return { candidates, warnings, unresolved }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const opts = parseArgs(process.argv.slice(2))
  const { candidates, warnings, unresolved } = run(opts)
  if (opts.list) {
    for (const c of candidates) console.log(`  ${c.file}:${c.line} issue #${c.issue}: ${c.text.slice(0, 100)}`)
    console.log(`candidates=${candidates.length}`)
  } else {
    for (const w of warnings) console.log(`  WARN: ${w.file}:${w.line} は「保留・未対応」の文脈で issue #${w.issue} を参照していますが、その issue は CLOSED です。文面を更新するか、歴史的記述なら文脈を直してください: ${w.text.slice(0, 100)}`)
    if (unresolved.length) console.log(`  (状態を取得できなかった issue: ${unresolved.map(n => '#' + n).join(', ')}。gh 未認証・ネットワーク不可の場合は判定をスキップします)`)
    console.log(`candidates=${candidates.length} warnings=${warnings.length} unresolved=${unresolved.length}`)
    if (opts.strict && warnings.length > 0) process.exit(1)
  }
}
