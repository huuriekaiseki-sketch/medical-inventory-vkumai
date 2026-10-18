#!/usr/bin/env node
// 止める hook が「止めた」回の記録（hook-decisions.jsonl、lib/log-hook-decision.sh が書く）を集計する。
// docs/specs/hook-decisions-summary.md の実装本体。入口は scripts/summarize-hook-decisions.sh。
// 静的 HTML の生成器（render-hook-decisions-html。中心リポジトリだけに置き、配らない）も**同じ関数**で
// 数える（テキストと HTML で件数がずれる道を作らない）。
//
// WHY(2026-10-18): 記録ができても、人が読める形が無ければ「hook が何を何回止めたか」は依然として
//      誰も見ない。いちばん大事なのは **0 件・少数のときに嘘をつかない**こと——記録が無い理由は
//      「止めていない」「記録が黙って飛んでいる」「期間の外」の 3 つがあり、集計は区別できないなら
//      区別できないと言う（docs/agents/check-design-pitfalls.md の C-025: 不在を合格と読まない）。
//
// 設計:
//   - I/O は main() とファイル読みだけ。集計（summarizeDecisions）と文章（formatText）は純粋関数
//   - 壊れた行（JSON 不正・必須項目の欠落・decision が語彙外）は**落とさず数えて別枠**で出す。
//     黙って落とすと記録部品のバグが「件数が少ない」に化ける
//   - 期間内 TABLE_THRESHOLD 件以上で表、未満は 1 件 1 行。数件の表は中身が薄く見えるだけ
//
// 使い方: node scripts/lib/hook-decisions-summary.mjs --log-file PATH [--days N] [--json] [--no-heading] [--now ISO8601]
//   --now はテスト・再現用（既定は現在時刻）。--no-heading は月次サマリのように見出しを呼び出し側が持つとき
//
// 限界:
//   - allow（黙って通した回）は記録されないので、発火率の分母は出せない
//   - 記録は「hook が判定を出した」ことで、「ツールが実際に止まった」ことではない
//   - 記録が無いとき、記録部品が運ばれていないのか本当に止めていないのかは、この出力だけでは分からない
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { writeLine } from './stdout-sync.mjs'

export const DECISIONS = ['deny', 'ask', 'warn']
export const CALLERS = ['claude', 'codex', 'unknown']
/** 期間内の件数がこれ以上なら表、未満なら 1 件 1 行 */
export const TABLE_THRESHOLD = 10
export const RECENT_LIMIT = 10
export const DEFAULT_DAYS = 30

/** JSONL の本文を行ごとに読む。壊れた行は落とさず、行番号と理由を返す */
export function parseLines(text) {
  const rows = []
  const broken = []
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return
    const lineNo = i + 1
    let row
    try {
      row = JSON.parse(line)
    } catch {
      broken.push({ line: lineNo, reason: 'JSON として読めない' })
      return
    }
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      broken.push({ line: lineNo, reason: 'オブジェクトでない' })
      return
    }
    if (typeof row.timestamp !== 'string' || row.timestamp === '') {
      broken.push({ line: lineNo, reason: 'timestamp が無い' })
      return
    }
    if (typeof row.hook !== 'string' || row.hook === '') {
      broken.push({ line: lineNo, reason: 'hook が空' })
      return
    }
    if (!DECISIONS.includes(row.decision)) {
      broken.push({ line: lineNo, reason: `decision が語彙外（${String(row.decision)}）` })
      return
    }
    rows.push(row)
  })
  return { rows, broken }
}

/** 記録ファイルの状態と本文。無い／空／ある を区別して返す */
export function loadLogFile(file) {
  if (!existsSync(file)) return { fileState: 'missing', text: '' }
  const text = readFileSync(file, 'utf8')
  if (text.trim() === '') return { fileState: 'empty', text: '' }
  return { fileState: 'present', text }
}

function emptyDecisionCounts() {
  return Object.fromEntries(DECISIONS.map((d) => [d, 0]))
}

/**
 * 集計。rows は parseLines の rows、broken は同 broken。
 * since（ISO8601）以上の timestamp を「期間内」とする。
 */
export function summarizeDecisions(rows, broken, { since, days, logFile, fileState }) {
  const inWindow = rows.filter((r) => r.timestamp >= since)
  const byHookDecision = {}
  const byRule = {}
  const byCaller = Object.fromEntries(CALLERS.map((c) => [c, 0]))
  let codexAskRelabeledAsDeny = 0
  for (const r of inWindow) {
    ;(byHookDecision[r.hook] ??= emptyDecisionCounts())[r.decision] += 1
    const rule = typeof r.rule === 'string' && r.rule !== '' ? r.rule : '(rule なし)'
    byRule[rule] = (byRule[rule] ?? 0) + 1
    const caller = CALLERS.includes(r.caller) ? r.caller : 'unknown'
    byCaller[caller] += 1
    if (r.caller === 'codex' && r.decision === 'ask') codexAskRelabeledAsDeny += 1
  }
  const sortedAll = [...rows].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
  const recent = [...inWindow]
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
    .slice(0, RECENT_LIMIT)
    .map((r) => ({
      timestamp: r.timestamp,
      hook: r.hook,
      decision: r.decision,
      rule: r.rule ?? '',
      tool_name: r.tool_name ?? '',
      target: r.target ?? '',
      caller: r.caller ?? '',
      agent_type: r.agent_type ?? '',
    }))
  return {
    logFile,
    days,
    since,
    fileState,
    total: { allTime: rows.length, inWindow: inWindow.length },
    latestTimestamp: sortedAll.length > 0 ? sortedAll[0].timestamp : null,
    byHookDecision,
    byRule,
    byCaller,
    codexAskRelabeledAsDeny,
    recent,
    broken: {
      count: broken.length,
      lines: broken.map((b) => b.line),
      reasons: broken.map((b) => `${b.line} 行目: ${b.reason}`),
    },
  }
}

const NO_RECORD_HINT =
  '止める hook が一度も deny / ask / warn を出していないか、記録が黙って飛んでいる' +
  '（記録部品 lib/log-hook-decision.sh が hook と一緒に配られていない・jq が無い・記録先に書けない）か、' +
  'この出力だけでは区別できない。手がかり: hook が読まれる側のチェックアウトに scripts/lib/log-hook-decision.sh があるか、' +
  '止める入力を 1 つ与えて 1 行増えるかを見る'

const FOOTNOTE =
  '注記: allow は記録されないので発火率の分母は無い。記録は「hook が判定を出した」ことで、「ツールが実際に止まった」ことではない'

function formatRecentLine(r) {
  const target = r.target === '' ? '(target なし)' : r.target
  const agent = r.agent_type ? ` / agent_type=${r.agent_type}` : ''
  return `- ${r.timestamp} / ${r.hook} / ${r.decision} / ${r.rule} / ${target} / ${r.caller}${agent}`
}

/** 見せ方の規則（仕様書「0 件・少数のときの見せ方」）に従って文章にする */
export function formatText(summary, { tableThreshold = TABLE_THRESHOLD, heading = true } = {}) {
  const out = []
  if (heading) {
    out.push(`## 止める hook が止めた回（hook-decisions.jsonl＝機械記録、直近${summary.days}日）`)
  }
  const brokenNote =
    summary.broken.count > 0 ? `。壊れた行 ${summary.broken.count} 件（${summary.broken.lines.join(', ')} 行目）` : ''

  if (summary.fileState === 'missing' || summary.fileState === 'empty') {
    const why = summary.fileState === 'missing' ? 'が無い' : 'が空'
    out.push(`記録なし（${summary.logFile} ${why}）。${NO_RECORD_HINT}${brokenNote}`)
    return out.join('\n')
  }
  if (summary.total.allTime === 0) {
    // 行はあるが全部壊れている。記録部品が壊れている可能性が高い
    out.push(`正しい記録が 0 件（${summary.logFile}）。${NO_RECORD_HINT}${brokenNote}`)
    return out.join('\n')
  }
  if (summary.total.inWindow === 0) {
    out.push(
      `直近 ${summary.days} 日は 0 件（全期間 ${summary.total.allTime} 件、最新 ${summary.latestTimestamp}）。` +
        '記録が過去に書けていたことは確かなので、この期間は止めた回が無かったと読んでよい。' +
        'ただし、その後に記録が壊れた可能性はこの出力からは除外できない' +
        brokenNote,
    )
    return out.join('\n')
  }

  out.push(
    `記録: 全期間 ${summary.total.allTime} 件 / 期間内 ${summary.total.inWindow} 件（最新 ${summary.latestTimestamp}）${brokenNote}`,
  )

  if (summary.total.inWindow < tableThreshold) {
    out.push(`期間内の全件（${summary.total.inWindow} 件。日時 / hook / decision / rule / target / caller）:`)
    for (const r of summary.recent) out.push(formatRecentLine(r))
    if (summary.codexAskRelabeledAsDeny > 0) {
      out.push(`うち caller=codex の ask ${summary.codexAskRelabeledAsDeny} 件は実際には deny に読み替えられている（Codex ラッパー）`)
    }
    out.push(FOOTNOTE)
    return out.join('\n')
  }

  out.push('')
  out.push('### hook × decision')
  out.push('| hook | deny | ask | warn | 計 |')
  out.push('| --- | --- | --- | --- | --- |')
  const hooks = Object.entries(summary.byHookDecision).sort((a, b) => {
    const ta = a[1].deny + a[1].ask + a[1].warn
    const tb = b[1].deny + b[1].ask + b[1].warn
    return tb - ta || a[0].localeCompare(b[0])
  })
  for (const [hook, c] of hooks) {
    out.push(`| ${hook} | ${c.deny} | ${c.ask} | ${c.warn} | ${c.deny + c.ask + c.warn} |`)
  }
  out.push('')
  out.push('### rule 別')
  for (const [rule, n] of Object.entries(summary.byRule).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    out.push(`- ${rule}: ${n}`)
  }
  out.push('')
  out.push('### caller 別')
  out.push(`- ${CALLERS.map((c) => `${c}: ${summary.byCaller[c]}`).join(' / ')}`)
  if (summary.codexAskRelabeledAsDeny > 0) {
    out.push(`  うち caller=codex の ask ${summary.codexAskRelabeledAsDeny} 件は実際には deny に読み替えられている（Codex ラッパー）`)
  }
  out.push('')
  out.push(`### 直近 ${summary.recent.length} 件（日時 / hook / decision / rule / target / caller）`)
  for (const r of summary.recent) out.push(formatRecentLine(r))
  out.push('')
  out.push(FOOTNOTE)
  return out.join('\n')
}

/** now - days 日 を ISO8601（秒まで）で返す */
export function sinceOf(now, days) {
  const t = new Date(now).getTime() - days * 86400000
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** ファイルを読んで集計まで。入口と HTML が共用する */
export function summarizeFile(logFile, { days = DEFAULT_DAYS, now = new Date().toISOString() } = {}) {
  const { fileState, text } = loadLogFile(logFile)
  const { rows, broken } = parseLines(text)
  return summarizeDecisions(rows, broken, { since: sinceOf(now, days), days, logFile, fileState })
}

function main(argv) {
  let logFile = null
  let days = DEFAULT_DAYS
  let asJson = false
  let heading = true
  let now = new Date().toISOString()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--log-file') logFile = argv[++i]
    else if (a === '--no-heading') heading = false
    else if (a === '--days') {
      const v = argv[++i]
      if (!/^\d+$/.test(v ?? '')) {
        process.stderr.write(`--days は 0 以上の整数（${v}）\n`)
        process.exit(2)
      }
      days = Number(v)
    } else if (a === '--json') asJson = true
    else if (a === '--now') {
      now = argv[++i]
      if (Number.isNaN(new Date(now).getTime())) {
        process.stderr.write(`--now は ISO8601（${now}）\n`)
        process.exit(2)
      }
    } else {
      process.stderr.write(`unknown option: ${a}\n`)
      process.exit(2)
    }
  }
  if (!logFile) {
    process.stderr.write('--log-file PATH が必要です\n')
    process.exit(2)
  }
  const summary = summarizeFile(path.resolve(logFile), { days, now })
  if (asJson) writeLine(JSON.stringify(summary, null, 2))
  else writeLine(formatText(summary, { heading }))
}

// WHY(realpath): `path.resolve` だけの比較だと、argv[1] が symlink 経由（macOS の /var/folders →
//      /private/var/folders。テストの mktemp -d がまさにこれ）のとき import.meta.url（実パス）と
//      一致せず main() が**黙ってスキップ**される。月次サマリは `|| true` で受けるので、空出力が
//      「取得できませんでした」に化けて誰も気づかない（gate-effectiveness-summary.ts と同じ型。
//      2026-10-18 に本テストの sandbox で実際に起きた）
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2))
}
