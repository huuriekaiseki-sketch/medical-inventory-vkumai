#!/usr/bin/env node
// 止めた回の記録・ハーネスの成績・hook 一覧を静的 HTML 1 枚にする（docs/specs/hook-decisions-summary.md）。
// 入口は scripts/render-hook-decisions-html.sh。
//
// WHY(2026-10-18): 「hook が名前どおり動くか」「止めた回数」「実走の生存確認」は別々の場所に散っていて、
//      棚卸しのたびに人が 3 か所を開いて突き合わせていた。1 枚に並べる——ただし **SNS 映えより中身の
//      正確さ**。件数が 0〜数件のときに表を並べると「薄いダッシュボード」になるだけなので、
//      止めた回の節は集計（lib/hook-decisions-summary.mjs）と**同じ関数・同じ規則**（0 件は文・少数は行・
//      多数は表）で出す。自己申告（harness-score）と機械記録（hook-decisions）は節を分け、出自を必ず書く。
//
// 節:
//   1. 止めた回       … hook-decisions.jsonl（機械記録。allow は書かれないので分母は無い）
//   2. ハーネスの成績 … `check-harness-score.mjs --summary` の TSV（**自己申告**。取れなければ断り書き、空の表は出さない）
//   3. hook 一覧      … .claude/settings.json と .codex/hooks.json の登録 × 止める力（スクリプト本文の
//                       permissionDecision / additionalContext で判定）× scripts/<name>.test.sh の有無
//                       × docs/agents/hook-live-drill.md に書かれた実走の最終記録日（**近似**）× 期間内に止めた回数
//
// 使い方: node scripts/lib/render-hook-decisions-html.mjs --root DIR --log-file PATH --out PATH
//           [--days N] [--now ISO8601] [--score-cmd "shell command"] [--drill PATH]
//
// 限界:
//   - 実走日はドリル文書の見出しと行に書かれた YYYY-MM-DD の最大値。書き忘れれば古いまま。実機で発火するかは測っていない
//   - 止める力の判定は本文の文字列（permissionDecision / additionalContext）で、実際に deny を返す経路があるかは見ない
//   - Codex 側の登録からの名前の取り出しは `"$(git rev-parse --show-toplevel)"/scripts/x.sh` の形に対する近似
//   - 外部読み込み（CSS / JS / フォント）は一切しない。オフラインで開けることを優先した
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import path from 'node:path'
import { writeLine } from './stdout-sync.mjs'
import { collectHookCommands, scriptNameOf } from './aidd-doctor.mjs'
import { CALLERS, DEFAULT_DAYS, TABLE_THRESHOLD, summarizeFile } from './hook-decisions-summary.mjs'

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const td = (v) => `<td>${esc(v)}</td>`
const th = (v) => `<th>${esc(v)}</th>`

// ---- 節 1: 止めた回 -------------------------------------------------------------------------

const NO_RECORD_HTML =
  '止める hook が一度も deny / ask / warn を出していないか、記録が黙って飛んでいる' +
  '（記録部品 lib/log-hook-decision.sh が hook と一緒に配られていない・jq が無い・記録先に書けない）か、' +
  'この 1 枚だけでは区別できない。手がかり: hook が読まれる側のチェックアウトに scripts/lib/log-hook-decision.sh があるか、' +
  '止める入力を 1 つ与えて 1 行増えるかを見る'

function recentLine(r) {
  const target = r.target === '' ? '(target なし)' : r.target
  const agent = r.agent_type ? ` / agent_type=${r.agent_type}` : ''
  return `${r.timestamp} / ${r.hook} / ${r.decision} / ${r.rule} / ${target} / ${r.caller}${agent}`
}

export function renderDecisionsSection(summary, { tableThreshold = TABLE_THRESHOLD } = {}) {
  const out = []
  out.push('<section id="decisions">')
  out.push(`<h2>1. 止める hook が止めた回（直近 ${esc(summary.days)} 日）</h2>`)
  out.push(
    `<p class="provenance">出自: <code>${esc(summary.logFile)}</code>（機械記録。lib/log-hook-decision.sh が判定を出す直前に書く）。` +
      'allow は書かれないので発火率の分母は無い。記録は「hook が判定を出した」ことで、「ツールが実際に止まった」ことではない</p>',
  )
  const brokenNote =
    summary.broken.count > 0
      ? `<p class="warn">壊れた行 ${esc(summary.broken.count)} 件（${esc(summary.broken.lines.join(', '))} 行目）。集計からは除いた。記録部品のバグの可能性があるので中身を見る</p>`
      : ''

  if (summary.fileState === 'missing' || summary.fileState === 'empty') {
    out.push(`<p class="warn">記録なし（ファイル${summary.fileState === 'missing' ? 'が無い' : 'が空'}）。${esc(NO_RECORD_HTML)}</p>`)
    out.push(brokenNote, '</section>')
    return out.join('\n')
  }
  if (summary.total.allTime === 0) {
    out.push(`<p class="warn">正しい記録が 0 件。${esc(NO_RECORD_HTML)}</p>`)
    out.push(brokenNote, '</section>')
    return out.join('\n')
  }
  if (summary.total.inWindow === 0) {
    out.push(
      `<p>直近 ${esc(summary.days)} 日は 0 件（全期間 ${esc(summary.total.allTime)} 件、最新 ${esc(summary.latestTimestamp)}）。` +
        '記録が過去に書けていたことは確かなので、この期間は止めた回が無かったと読んでよい。ただし、その後に記録が壊れた可能性はこの 1 枚からは除外できない</p>',
    )
    out.push(brokenNote, '</section>')
    return out.join('\n')
  }

  out.push(
    `<p>記録: 全期間 ${esc(summary.total.allTime)} 件 / 期間内 ${esc(summary.total.inWindow)} 件（最新 ${esc(summary.latestTimestamp)}）</p>`,
  )
  out.push(brokenNote)

  if (summary.total.inWindow < tableThreshold) {
    out.push(`<p>期間内の全件（${esc(summary.total.inWindow)} 件。少数なので表にせず 1 件 1 行。日時 / hook / decision / rule / target / caller）:</p>`)
    out.push('<ul>')
    for (const r of summary.recent) out.push(`<li>${esc(recentLine(r))}</li>`)
    out.push('</ul>')
    if (summary.codexAskRelabeledAsDeny > 0) {
      out.push(`<p>うち caller=codex の ask ${esc(summary.codexAskRelabeledAsDeny)} 件は実際には deny に読み替えられている（Codex ラッパー）</p>`)
    }
    out.push('</section>')
    return out.join('\n')
  }

  out.push('<h3>hook × decision</h3>')
  out.push('<table><thead><tr>' + ['hook', 'deny', 'ask', 'warn', '計'].map(th).join('') + '</tr></thead><tbody>')
  const hooks = Object.entries(summary.byHookDecision).sort((a, b) => {
    const ta = a[1].deny + a[1].ask + a[1].warn
    const tb = b[1].deny + b[1].ask + b[1].warn
    return tb - ta || a[0].localeCompare(b[0])
  })
  for (const [hook, c] of hooks) {
    out.push('<tr>' + [hook, c.deny, c.ask, c.warn, c.deny + c.ask + c.warn].map(td).join('') + '</tr>')
  }
  out.push('</tbody></table>')

  out.push('<h3>rule 別</h3>')
  out.push('<table><thead><tr>' + ['rule', '件数'].map(th).join('') + '</tr></thead><tbody>')
  for (const [rule, n] of Object.entries(summary.byRule).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    out.push('<tr>' + [rule, n].map(td).join('') + '</tr>')
  }
  out.push('</tbody></table>')

  out.push('<h3>caller 別</h3>')
  out.push('<table><thead><tr>' + CALLERS.map(th).join('') + '</tr></thead><tbody>')
  out.push('<tr>' + CALLERS.map((c) => td(summary.byCaller[c])).join('') + '</tr>')
  out.push('</tbody></table>')
  if (summary.codexAskRelabeledAsDeny > 0) {
    out.push(`<p>うち caller=codex の ask ${esc(summary.codexAskRelabeledAsDeny)} 件は実際には deny に読み替えられている（Codex ラッパー）</p>`)
  }

  out.push(`<h3>直近 ${esc(summary.recent.length)} 件</h3>`)
  out.push('<table><thead><tr>' + ['日時', 'hook', 'decision', 'rule', 'tool_name', 'target', 'caller', 'agent_type'].map(th).join('') + '</tr></thead><tbody>')
  for (const r of summary.recent) {
    out.push('<tr>' + [r.timestamp, r.hook, r.decision, r.rule, r.tool_name, r.target, r.caller, r.agent_type].map(td).join('') + '</tr>')
  }
  out.push('</tbody></table>')
  out.push('</section>')
  return out.join('\n')
}

// ---- 節 2: ハーネスの成績（自己申告） -----------------------------------------------------------

/**
 * 成績の検査を回して TSV を取る。結果は 4 種に分ける（C-025: 取れなかったを合格にも違反にも混ぜない）:
 *   ok（表がある）/ none（記録が無い、exit 4）/ violation（検査が違反を報告、exit 1）/ failed（それ以外）
 */
export function runHarnessScore({ root, scoreCmd = null }) {
  let stdout = ''
  let code = 0
  try {
    if (scoreCmd) {
      stdout = execSync(scoreCmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 })
    } else {
      const script = path.join(root, 'scripts/lib/check-harness-score.mjs')
      if (!existsSync(script)) return { state: 'failed', reason: `${script} が無い`, rows: [] }
      // WHY(realpath): 検査の入口判定は argv[1] と import.meta.url の実パス比較。symlink 配下の root を渡すと黙る
      stdout = execFileSync(process.execPath, [realpathSync(script), '--root', root, '--summary'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 20000,
      })
    }
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : -1
    stdout = typeof e.stdout === 'string' ? e.stdout : ''
  }
  const lines = stdout.split('\n').filter((l) => l.trim() !== '')
  const headerIdx = lines.findIndex((l) => l.startsWith('layer\tcomponent\t'))
  if (code === 4) return { state: 'none', reason: lines[0] ?? '記録が無い', rows: [] }
  if (code === 1) return { state: 'violation', reason: lines.find((l) => l.includes('違反')) ?? lines[0] ?? '検査が違反を報告', rows: [] }
  if (code !== 0 || headerIdx === -1) return { state: 'failed', reason: lines[0] ?? `exit ${code}、表が出なかった`, rows: [] }
  const header = lines[headerIdx].split('\t')
  const rows = lines.slice(headerIdx + 1).map((l) => {
    const cells = l.split('\t')
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']))
  })
  return { state: 'ok', reason: '', rows, header }
}

export function renderScoreSection(score) {
  const out = []
  out.push('<section id="harness-score">')
  out.push('<h2>2. ハーネスの成績（部品 × 層）</h2>')
  out.push(
    '<p class="provenance">出自: <code>docs/agents/harness-score.jsonl</code>（<strong>自己申告</strong>。issue を閉じるとき人が書く。' +
      '形と語彙は check-harness-score.mjs が検査するが、中身が本当に起きたことかは見ていない）。' +
      '止めた / 見逃した / 邪魔した の件数と、仕分けの規則（止めたが 1 件でもあれば keep、無くて見逃したがあれば fix-or-drop、邪魔しただけなら drop）</p>',
  )
  if (score.state === 'none') {
    out.push(`<p class="warn">成績の記録が無い（${esc(score.reason)}）。まだ 1 行も書かれていないか、場所が違う。合格でも失敗でもない</p>`)
  } else if (score.state === 'violation') {
    out.push(`<p class="warn">成績を取得できませんでした: 検査が違反を報告している（${esc(score.reason)}）。記録を直してから読み直す</p>`)
  } else if (score.state !== 'ok') {
    out.push(`<p class="warn">成績を取得できませんでした（${esc(score.reason)}）。記録が無いのか検査が動かないのかは、この文からは分からない</p>`)
  } else if (score.rows.length === 0) {
    out.push('<p class="warn">成績の記録はあるが、集計の行が 0 件（検査は通った）</p>')
  } else {
    out.push('<table><thead><tr>' + score.header.map(th).join('') + '</tr></thead><tbody>')
    for (const r of score.rows) out.push('<tr>' + score.header.map((h) => td(r[h])).join('') + '</tr>')
    out.push('</tbody></table>')
  }
  out.push('</section>')
  return out.join('\n')
}

// ---- 節 3: hook 一覧 ------------------------------------------------------------------------

const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g

/**
 * ドリル文書から hook ごとの最終記録日（近似）。**表の行**（`|` で始まる行）だけを見る——
 * 実施結果はすべて表で書かれており、散文の行まで見ると「`maintenance-digest.sh` に期限が載っていた」
 * のような言及が、その節の見出しの日付（2026-09-11）を実走日として拾ってしまった（2026-10-18 に実測）。
 * 行の中の日付と、その表が属する見出しの日付の最大値を取る
 */
export function lastDrillDates(mdText, hookNames) {
  const result = new Map()
  let headingDate = null
  for (const line of mdText.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      const dates = [...line.matchAll(DATE_RE)].map((m) => m[1])
      headingDate = dates.length > 0 ? dates.sort().at(-1) : null
      continue
    }
    if (!/^\s*\|/.test(line)) continue
    for (const name of hookNames) {
      if (!line.includes(name)) continue
      const dates = [...line.matchAll(DATE_RE)].map((m) => m[1])
      if (headingDate) dates.push(headingDate)
      if (dates.length === 0) continue
      const latest = dates.sort().at(-1)
      const prev = result.get(name)
      if (!prev || latest > prev) result.set(name, latest)
    }
  }
  return result
}

/**
 * スクリプト本文から「止める力」を推定する（文字列判定。実際に deny を返す経路があるかは見ない）。
 * コメント行は除く。`permissionDecision: "deny"` / `"ask"`（jq の出力）と、Codex ラッパーの
 * `.permissionDecision = "deny"`（読み替え）を拾う。`permissionDecision: "allow"` だけの hook
 * （check-run-manifest-presence のような警告のみ）は additionalContext があれば warn。
 * 実測（2026-10-18）: 語だけで判定すると allow のみの hook も「deny / ask」に見えた
 */
export function classifyHookPower(scriptText, event) {
  if (scriptText === null) return '実体なし'
  const code = scriptText
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
  if (/permissionDecision["']?\s*[:=]\s*["'](deny|ask)["']/.test(code)) return 'deny / ask'
  if (event === 'PreToolUse' && /additionalContext/.test(code)) return 'warn'
  return '—'
}

export function collectHooks(root) {
  const configs = [
    { file: path.join(root, '.claude/settings.json'), tool: 'claude' },
    { file: path.join(root, '.codex/hooks.json'), tool: 'codex' },
  ]
  const byName = new Map()
  for (const { file, tool } of configs) {
    for (const { event, command } of collectHookCommands(file)) {
      const script = scriptNameOf(command)
      if (!script) continue
      const name = script.replace(/\.(sh|mjs|js|py)$/, '')
      const entry = byName.get(name) ?? { name, script, tools: new Set(), events: new Set() }
      entry.tools.add(tool)
      entry.events.add(event)
      byName.set(name, entry)
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function renderHooksSection({ root, summary, drillPath }) {
  const hooks = collectHooks(root)
  const out = []
  out.push('<section id="hooks">')
  out.push('<h2>3. hook 一覧 × .test.sh の有無 × 実走の最終記録日 × 期間内に止めた回数</h2>')
  out.push(
    `<p class="provenance">出自: <code>.claude/settings.json</code> と <code>.codex/hooks.json</code> の登録（機械）。` +
      '「止める力」はスクリプト本文に permissionDecision / additionalContext があるかの文字列判定（実際に deny を返す経路があるかは見ない）。' +
      `「実走の最終記録日」は <code>${esc(path.relative(root, drillPath))}</code> の表の行と、その表の見出しに書かれた日付からの<strong>近似</strong>` +
      '（書き忘れれば古いまま。実機で発火するかは測っていない）。「期間内に止めた回数」は節 1 と同じ記録。' +
      '止める力があるのに回数が 0 の行は、止める場面が無かったか、記録が飛んでいるかのどちらか</p>',
  )
  if (hooks.length === 0) {
    out.push('<p class="warn">hook の登録が見つかりません（.claude/settings.json / .codex/hooks.json が無いか、hooks が空）</p>')
    out.push('</section>')
    return out.join('\n')
  }
  const drillText = existsSync(drillPath) ? readFileSync(drillPath, 'utf8') : ''
  const drillDates = lastDrillDates(drillText, hooks.map((h) => h.name))
  out.push(
    '<table><thead><tr>' +
      ['hook', 'ツール', 'イベント', '止める力', '.test.sh', '実走の最終記録日', `期間内に止めた回数（${esc(summary.days)} 日）`].map(th).join('') +
      '</tr></thead><tbody>',
  )
  for (const h of hooks) {
    const scriptPath = path.join(root, 'scripts', h.script)
    const scriptText = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : null
    const testPath = path.join(root, 'scripts', `${h.name}.test.sh`)
    const counts = summary.byHookDecision[h.name]
    const n = counts ? counts.deny + counts.ask + counts.warn : 0
    const power = classifyHookPower(scriptText, [...h.events][0])
    out.push(
      `<tr data-hook="${esc(h.name)}">` +
        [
          h.name,
          [...h.tools].sort().join(', '),
          [...h.events].sort().join(', '),
          power,
          existsSync(testPath) ? 'あり' : 'なし',
          drillDates.get(h.name) ?? '記録なし',
          n,
        ]
          .map(td)
          .join('') +
        '</tr>',
    )
  }
  out.push('</tbody></table>')
  out.push(`<p>${esc(hooks.length)} 本。実体なし＝登録はあるが scripts/ にファイルが無い（登録の腐敗。aidd-doctor も検知する）</p>`)
  out.push('</section>')
  return out.join('\n')
}

// ---- 1 枚にまとめる -------------------------------------------------------------------------

const CSS = `
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; line-height: 1.5; margin: 0 auto; max-width: 1100px; padding: 16px; }
h1 { font-size: 1.4rem; } h2 { font-size: 1.15rem; margin-top: 2rem; border-bottom: 1px solid #8884; padding-bottom: .2rem; }
h3 { font-size: 1rem; margin-top: 1.2rem; }
table { border-collapse: collapse; margin: .5rem 0 1rem; font-size: .92rem; }
th, td { border: 1px solid #8886; padding: .25rem .6rem; text-align: left; vertical-align: top; }
th { background: #8882; }
td:nth-child(n+2):not(:has(*)) { font-variant-numeric: tabular-nums; }
p.provenance { font-size: .88rem; opacity: .85; }
p.warn { border-left: 4px solid #c90; padding-left: .6rem; }
code { font-size: .9em; }
footer { margin-top: 2rem; font-size: .85rem; opacity: .8; }
`

export function renderPage({ root, summary, score, drillPath, now }) {
  const out = []
  out.push('<!doctype html>')
  out.push('<html lang="ja"><head><meta charset="utf-8">')
  out.push('<meta name="viewport" content="width=device-width, initial-scale=1">')
  out.push('<title>hook の止めた回と生存確認</title>')
  out.push(`<style>${CSS}</style></head><body>`)
  out.push('<h1>hook の止めた回と生存確認</h1>')
  out.push(
    `<p>生成: ${esc(now)}（UTC）。対象: <code>${esc(root)}</code>。期間: 直近 ${esc(summary.days)} 日（${esc(summary.since)} 以降）。` +
      '3 つの節は出自が違う（1 と 3 の登録は機械、2 は自己申告）。節ごとの「出自」を読んでから数字を読む</p>',
  )
  out.push(renderDecisionsSection(summary))
  out.push(renderScoreSection(score))
  out.push(renderHooksSection({ root, summary, drillPath }))
  out.push('<footer>静的 HTML。外部読み込みなし。作り方: <code>bash scripts/render-hook-decisions-html.sh</code>（docs/specs/hook-decisions-summary.md）</footer>')
  out.push('</body></html>')
  return out.join('\n')
}

function main(argv) {
  let root = null
  let logFile = null
  let outFile = null
  let days = DEFAULT_DAYS
  let now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  let scoreCmd = null
  let drill = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') root = path.resolve(argv[++i])
    else if (a === '--log-file') logFile = path.resolve(argv[++i])
    else if (a === '--out') outFile = path.resolve(argv[++i])
    else if (a === '--days') {
      const v = argv[++i]
      if (!/^\d+$/.test(v ?? '')) {
        process.stderr.write(`--days は 0 以上の整数（${v}）\n`)
        process.exit(2)
      }
      days = Number(v)
    } else if (a === '--now') now = argv[++i]
    else if (a === '--score-cmd') scoreCmd = argv[++i]
    else if (a === '--drill') drill = path.resolve(argv[++i])
    else {
      process.stderr.write(`unknown option: ${a}\n`)
      process.exit(2)
    }
  }
  if (!root || !logFile || !outFile) {
    process.stderr.write('--root DIR --log-file PATH --out PATH が必要です\n')
    process.exit(2)
  }
  const summary = summarizeFile(logFile, { days, now })
  const score = runHarnessScore({ root, scoreCmd })
  const drillPath = drill ?? path.join(root, 'docs/agents/hook-live-drill.md')
  const html = renderPage({ root, summary, score, drillPath, now })
  mkdirSync(path.dirname(outFile), { recursive: true })
  writeFileSync(outFile, html)
  writeLine(`書き出しました: ${outFile}（止めた回 期間内 ${summary.total.inWindow} 件 / 成績 ${score.state} / hook ${collectHooks(root).length} 本）`)
}

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
