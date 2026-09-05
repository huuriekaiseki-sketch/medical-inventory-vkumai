// グラフマニフェスト（.claude/workflows/graph/aidd-graph.mjs）から配線図を生成する（issue #710）。
//
// 出力:
//   docs/aidd-pipeline.html   … 人間向けの一覧（Workflow ごとに phase → ノード → エッジ、blocked の復帰先）
//   docs/agents/aidd-graph.md … Mermaid flowchart（docs/agents から参照する軽量版）
// どちらも生成物で手編集禁止。鮮度は scripts/check-aidd-graph-rendered.test.sh（CI hooks-test /
// docs-integrity-check）が `--check` で検査する。
//
// 使い方:
//   node scripts/lib/render-aidd-graph.mjs            # 2 ファイルを書き出す
//   node scripts/lib/render-aidd-graph.mjs --check    # 書き出さず、コミット済みファイルと一致するか検査（不一致で exit 1）
//   node scripts/lib/render-aidd-graph.mjs --out <dir>  # 出力先ルートを差し替え（テスト用）

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const MANIFEST = path.join(REPO_ROOT, '.claude/workflows/graph/aidd-graph.mjs')
const HEADER_NOTE = 'GENERATED FILE — DO NOT EDIT. Source: .claude/workflows/graph/aidd-graph.mjs. Regenerate: node scripts/lib/render-aidd-graph.mjs (issue #710)'

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const mermaidLabel = s => String(s).replace(/"/g, "'").replace(/[\[\]{}()<>|]/g, m => ({ '[': '［', ']': '］', '{': '｛', '}': '｝', '(': '（', ')': '）', '<': '＜', '>': '＞', '|': '｜' }[m]))
// Mermaid flowchart の予約語（end / graph 等）はノード id に使えないため末尾に _ を付ける
const MERMAID_RESERVED = new Set(['end', 'graph', 'subgraph', 'style', 'class', 'click', 'linkStyle', 'classDef', 'direction'])
const mermaidId = id => (MERMAID_RESERVED.has(id) ? `${id}_` : id)

function returnsToLabel(graph, key) {
  if (!key) return ''
  if (key === 'human') return '人間（オーケストレーターが detail を読んで判断）'
  if (key === 'resumeFromRunId') return 'resumeFromRunId（docs/agents/workflow-resume-runbook.md）'
  return graph.humanGates[key]?.label ?? key
}

export function renderHtml(graph) {
  const wfSections = Object.entries(graph.workflows).map(([name, wf]) => {
    const phases = [...new Set(wf.nodes.map(n => n.phase))]
    const phaseBlocks = phases.map(phase => {
      const nodes = wf.nodes.filter(n => n.phase === phase)
      const nodeItems = nodes.map(n => {
        const meta = [
          n.kind,
          n.agentType ? `agentType=${n.agentType}` : null,
          n.model ? `model=${n.model}` : null,
          n.effort ? `effort=${n.effort}` : null,
          n.fanout ? `fanout=${n.fanout}` : null,
          n.parallelGroup ? `parallel:${n.parallelGroup}` : null,
          n.veto ? 'veto' : null,
        ].filter(Boolean)
        return `<li class="node kind-${esc(n.kind)}${n.veto ? ' veto' : ''}"><code>${esc(n.id)}</code> ${esc(n.label)}<span class="meta">${meta.map(esc).join(' · ')}</span></li>`
      })
      return `<section class="phase"><h3>${esc(phase)}</h3><ul>${nodeItems.join('')}</ul></section>`
    })
    const edgeRows = wf.edges.map(e => `<tr class="on-${esc(e.on.replace(/[^a-z-]/gi, ''))}"><td><code>${esc(e.from)}</code></td><td>${esc(e.on)}</td><td><code>${esc(e.to)}</code></td><td>${e.blockedAt ? `<code>${esc(e.blockedAt)}</code>` : ''}</td><td>${esc(returnsToLabel(graph, e.returnsTo))}</td><td>${esc(e.note ?? '')}</td></tr>`)
    const budgets = Object.entries(wf.budgets).map(([k, v]) => `<li><code>${esc(k)}</code> = ${esc(typeof v === 'number' ? v.toLocaleString('en-US') : v)}</li>`)
    return `
<article class="workflow" id="${esc(name)}">
  <h2>${esc(name)} <small>${esc(wf.file)}</small></h2>
  <p class="pattern">パターン: ${esc(wf.pattern)}</p>
  ${budgets.length ? `<ul class="budgets">${budgets.join('')}</ul>` : ''}
  <div class="phases">${phaseBlocks.join('')}</div>
  <table class="edges"><thead><tr><th>from</th><th>on</th><th>to</th><th>blockedAt</th><th>復帰先</th><th>備考</th></tr></thead><tbody>${edgeRows.join('')}</tbody></table>
</article>`
  })
  const gates = Object.entries(graph.humanGates).map(([k, g]) => `<li><b>${esc(g.label)}</b> <code>${esc(k)}</code> — ${esc(g.description)}${g.reenter ? `（再開: <code>${esc(g.reenter)}</code>）` : ''}</li>`)
  return `<!DOCTYPE html>
<!-- ${HEADER_NOTE} -->
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AIDD Pipeline Graph — medical-inventory-vkumai</title>
<style>
  :root { --bg:#0b1020; --surface:#121a2e; --border:#243050; --text:#c8d8f0; --dim:#7a90b0; --accent:#00d4ff; --gate:#ffb800; --end:#00e87a; --agent:#b48efe; --code:#9fb3c8; }
  body { margin:0; background:var(--bg); color:var(--text); font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size:13px; line-height:1.5; }
  .wrap { max-width:1200px; margin:0 auto; padding:32px 20px 80px; }
  h1 { color:#fff; font-size:26px; margin:0 0 4px; } h1 small, h2 small { color:var(--dim); font-weight:normal; font-size:12px; margin-left:8px; }
  .gen { color:var(--dim); font-size:11px; margin-bottom:24px; }
  h2 { color:var(--accent); font-size:18px; margin:40px 0 6px; border-bottom:1px solid var(--border); padding-bottom:6px; }
  h3 { color:#fff; font-size:13px; margin:0 0 8px; letter-spacing:.08em; text-transform:uppercase; }
  .pattern { color:var(--dim); margin:0 0 8px; }
  .budgets { color:var(--dim); margin:0 0 12px; padding-left:18px; }
  .phases { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; margin-bottom:16px; }
  .phase { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 14px; }
  .phase ul { list-style:none; margin:0; padding:0; }
  .node { padding:6px 0; border-top:1px dashed var(--border); }
  .node:first-child { border-top:0; }
  .node .meta { display:block; color:var(--dim); font-size:11px; }
  .kind-gate code { color:var(--gate); } .kind-end code { color:var(--end); } .kind-agent code { color:var(--agent); } .kind-code code, .kind-workflow code { color:var(--code); }
  .veto::before { content:"⛔ "; }
  table.edges { width:100%; border-collapse:collapse; font-size:12px; }
  table.edges th, table.edges td { border:1px solid var(--border); padding:4px 8px; vertical-align:top; text-align:left; }
  table.edges th { background:var(--surface); color:var(--dim); font-weight:normal; }
  tr.on-blocked td:nth-child(2), tr.on-token-cap td:nth-child(2) { color:#ff4d6a; }
  tr.on-retry td:nth-child(2), tr.on-loop td:nth-child(2) { color:var(--gate); }
  tr.on-pass td:nth-child(2) { color:var(--end); }
  .gates li { margin-bottom:6px; }
  code { font-family: inherit; }
  @media (max-width:700px) { table.edges { display:block; overflow-x:auto; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>AIDD Pipeline Graph <small>medical-inventory-vkumai</small></h1>
  <p class="gen">${esc(HEADER_NOTE)}</p>
  <section>
    <h2>人間ゲート</h2>
    <ul class="gates">${gates.join('')}</ul>
  </section>
  ${wfSections.join('\n')}
</div>
</body>
</html>
`
}

export function renderMermaid(graph) {
  const blocks = Object.entries(graph.workflows).map(([name, wf]) => {
    const lines = ['flowchart TD']
    for (const n of wf.nodes) {
      const label = mermaidLabel(`${n.phase}: ${n.id}`)
      const shape = n.kind === 'gate' ? `{{"${label}"}}` : n.kind === 'end' ? `(["${label}"])` : n.kind === 'code' || n.kind === 'workflow' ? `[["${label}"]]` : `["${label}"]`
      lines.push(`  ${mermaidId(n.id)}${shape}`)
    }
    for (const e of wf.edges) {
      const tag = e.blockedAt ? `${e.on}: ${e.blockedAt} → ${e.returnsTo}` : e.on
      lines.push(`  ${mermaidId(e.from)} -->|"${mermaidLabel(tag)}"| ${mermaidId(e.to)}`)
    }
    const budgets = Object.entries(wf.budgets).map(([k, v]) => `- \`${k}\` = ${typeof v === 'number' ? v.toLocaleString('en-US') : v}`).join('\n')
    const blockedTable = wf.edges.filter(e => e.blockedAt).map(e => `| \`${e.blockedAt}\` | ${returnsToLabel(graph, e.returnsTo)} | ${e.note ?? ''} |`).join('\n')
    return `## ${name}（\`${wf.file}\`）

パターン: ${wf.pattern}

${budgets ? `予算・上限:\n${budgets}\n` : ''}
\`\`\`mermaid
${lines.join('\n')}
\`\`\`
${blockedTable ? `
blocked / token-cap の復帰先:

| blockedAt | 復帰先 | 備考 |
|---|---|---|
${blockedTable}
` : ''}`
  })
  const gates = Object.entries(graph.humanGates).map(([k, g]) => `- **${g.label}**（\`${k}\`）: ${g.description}${g.reenter ? `（再開: \`${g.reenter}\`）` : ''}`).join('\n')
  return `<!-- ${HEADER_NOTE} -->
# AIDD パイプライン配線図（生成物）

正本は \`.claude/workflows/graph/aidd-graph.mjs\`。このファイルと \`docs/aidd-pipeline.html\` は
\`node scripts/lib/render-aidd-graph.mjs\` で生成する（手編集禁止。鮮度は
\`scripts/check-aidd-graph-rendered.test.sh\` が検査）。マニフェストと各 Workflow DSL の一致は
\`.claude/workflows/lib/__tests__/graph-manifest-sync.test.js\` が \`npm test\` で検査する（issue #710）。

## 人間ゲート

${gates}

${blocks.join('\n')}
`
}

export function render(graph) {
  return {
    'docs/aidd-pipeline.html': renderHtml(graph),
    'docs/agents/aidd-graph.md': renderMermaid(graph),
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const outIdx = args.indexOf('--out')
  const outRoot = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : REPO_ROOT
  const { GRAPH } = await import(pathToFileURL(MANIFEST).href)
  const outputs = render(GRAPH)
  let stale = 0
  for (const [rel, content] of Object.entries(outputs)) {
    const abs = path.join(outRoot, rel)
    if (check) {
      const current = existsSync(abs) ? readFileSync(abs, 'utf-8') : null
      if (current !== content) {
        stale++
        console.log(`  NG: ${rel} が生成結果と一致しません（node scripts/lib/render-aidd-graph.mjs で再生成してください）`)
      } else {
        console.log(`  OK: ${rel}`)
      }
    } else {
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, content)
      console.log(`wrote ${rel}`)
    }
  }
  if (check && stale > 0) process.exit(1)
}
