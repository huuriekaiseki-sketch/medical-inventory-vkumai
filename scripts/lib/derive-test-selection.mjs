// 必須テスト機械導出（derive）のエンジン。「共通」部分であり、このリポジトリ固有の
// パス表・キーは一切持たない（固有部分は derive-test-selection.rules.mjs）。
//
// WHY: 引き継ぎメモ「04 どう確認したか」の「⬜ 未実施」が「今回不要」なのか「穴」なのかを
//      人の記憶ではなく機械が決める。kojigyo-zei-rag の scripts/derive-test-selection.sh
//      （bash case 表）を、vkumai の高リスク判定の正本 classifyRoute（router-risk.js）の
//      上に載せ直したもの。エンジンとルールを分けたのは、派生リポジトリへ持っていくときに
//      ルールだけ書き換えればよい形にするため（docs/agents/portability-inventory.md）。
//
// 入力: 変更ファイルパス（stdin 1行1パス、または --files a,b,c）
// 出力: --format json（既定）/ table（04 表にそのまま貼れる Markdown）
//       --list-keys で derive キー一覧のみ出力（構造テストが test-matrix.md と突合する）
//       --list-risks でリスク申告キー一覧のみ出力
//
// 使い方は scripts/derive-test-selection.sh（git diff を取って本ファイルへ渡す薄いラッパー）。

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')

const { RULES, RISK_KEYS, CLASSIFIED_PATH_PATTERNS } = await import(
  pathToFileURL(path.join(__dirname, 'derive-test-selection.rules.mjs')).href
)
const { classifyRoute } = await import(
  pathToFileURL(path.join(REPO_ROOT, '.claude/workflows/lib/router-risk.js')).href
)

function parseArgs(argv) {
  const opts = { format: 'json', risks: [], files: null, listKeys: false, listRules: false, listRisks: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--format') opts.format = argv[++i]
    else if (a === '--risk') opts.risks = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--files') opts.files = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--list-keys') opts.listKeys = true
    else if (a === '--list-rules') opts.listRules = true
    else if (a === '--list-risks') opts.listRisks = true
    else if (a === 'json' || a === 'table') opts.format = a
    else throw new Error(`unknown argument: ${a}`)
  }
  return opts
}

function readStdinLines() {
  let text = ''
  try {
    text = readFileSync(0, 'utf8')
  } catch {
    return []
  }
  return text.split('\n').map(s => s.trim()).filter(Boolean)
}

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '')
}

function resolveCommands(rule, ctx) {
  const c = typeof rule.commands === 'function' ? rule.commands(ctx) : rule.commands
  return c ?? []
}

export function derive(files, risks = []) {
  const unknownRisks = risks.filter(r => !RISK_KEYS.includes(r))
  if (unknownRisks.length > 0) throw new Error(`unknown risk key: ${unknownRisks.join(', ')}`)

  const normalized = [...new Set(files.map(normalize))]
  const route = classifyRoute('', normalized)
  const ctx = { files: normalized, route, risks }

  const required = []
  const notRequired = []
  const milestone = []

  for (const rule of RULES) {
    const base = { key: rule.key, label: rule.label, status: rule.status ?? 'ready' }
    if (rule.timing === 'always') {
      required.push({ ...base, why: '毎回（CI が全 PR で回す）', commands: resolveCommands(rule, ctx) })
      continue
    }
    const t = rule.trigger ? rule.trigger(ctx) : { hit: false, why: '' }
    if (rule.timing === 'on-change') {
      if (t.hit) required.push({ ...base, why: t.why, commands: resolveCommands(rule, ctx) })
      else notRequired.push({ ...base, reason: rule.notRequiredReason })
      continue
    }
    // milestone: 通常は「いつ回すか」だけ出し、trigger が hit したときのみ required に昇格
    if (t.hit) required.push({ ...base, why: t.why, commands: resolveCommands(rule, ctx) })
    else milestone.push({ ...base, event: rule.event })
  }

  const unclassified = normalized.filter(f => !CLASSIFIED_PATH_PATTERNS.some(re => re.test(f)))

  return {
    route: route.route,
    isHighRisk: route.isHighRisk,
    matchedPaths: route.matchedPaths,
    risks,
    files: normalized,
    required,
    not_required: notRequired,
    milestone,
    unclassified,
  }
}

// 04 表にそのまま貼れる形。required は「⬜ 未実施」で出し、実施後に ✅ へ書き換える前提
// （derive が決めるのは「要るか要らないか」まで。実施したかは人が書く）。
export function renderTable(result) {
  const lines = []
  lines.push('| 種別（test-matrix.md の行） | 状態 | 結果・証跡 |')
  lines.push('| --- | --- | --- |')
  for (const r of result.required) {
    const note = r.status === 'not-ready' ? '（種別は未整備。個別テストで代替）' : ''
    const cmd = r.commands.length > 0 ? `。実行: ${r.commands.join(' / ')}` : ''
    lines.push(`| ${r.label} | ⬜ 未実施 | 要実施${note}: ${r.why}${cmd} |`)
  }
  for (const n of result.not_required) {
    lines.push(`| ${n.label} | ➖ 今回不要 | ${n.reason} |`)
  }
  for (const m of result.milestone) {
    lines.push(`| ${m.label} | ➖ 今回不要 | 節目の種別（${m.event}） |`)
  }
  lines.push('')
  lines.push(`route: ${result.route}${result.matchedPaths.length > 0 ? ` (matchedPaths: ${result.matchedPaths.join(', ')})` : ''}`)
  if (result.unclassified.length > 0) {
    lines.push(`unclassified（ルールに無いパス。新しい層なら rules.mjs に足す）: ${result.unclassified.join(', ')}`)
  }
  return lines.join('\n')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }))
    process.exit(2)
  }
  if (opts.listKeys) {
    console.log(RULES.map(r => r.key).join('\n'))
    process.exit(0)
  }
  if (opts.listRules) {
    // key <TAB> label <TAB> timing。構造テストが test-matrix.md の derive キー列・種別列・
    // 実施タイミング列と突合するための機械可読出力
    console.log(RULES.map(r => `${r.key}\t${r.label}\t${r.timing}`).join('\n'))
    process.exit(0)
  }
  if (opts.listRisks) {
    console.log(RISK_KEYS.join('\n'))
    process.exit(0)
  }
  const files = opts.files ?? readStdinLines()
  let result
  try {
    result = derive(files, opts.risks)
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }))
    process.exit(2)
  }
  if (opts.format === 'table') console.log(renderTable(result))
  else console.log(JSON.stringify(result, null, 2))
}
