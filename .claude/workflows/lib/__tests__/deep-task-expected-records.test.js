import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractDeclaration } from '../extract-declaration.js'

// WHY(issue #807): deep ワークフローは「記録されるはずの件数」を agentType から数えて返し、gap check が
//      実際の記録件数と突き合わせる。ところが agentType は**権限のために**付けている場合がある。
//      木の状態を取るだけの補助役（capture-tree）は、読み取り専用ガードを効かせるために `reviewer` で起動するが、
//      プロンプトは「結果だけ返せ」で記録を呼ばない。2026-09-20 に 2 回の実行を transcript から数えると、
//      この 2 体は loop・progress とも 0/2 で、毎回「記録漏れ 2 件」として gap check に乗っていた。
//
//      Workflow DSL のスクリプトは丸ごとは実行できない（トップレベル await と DSL のグローバルに依存する）ので、
//      数える関数だけを生テキストで取り出して動かす。
const SOURCE = readFileSync(join(__dirname, '../../aidd-1-1-deep-task.js'), 'utf-8')

function loadTrackedAgent() {
  const fnSource = extractDeclaration(SOURCE, 'trackedAgent')
  // WHY(new Function を使ってよい範囲): 埋め込むのは**このリポジトリ自身のワークフローのソース**だけで、
  //      外部の入力・利用者の入力は 1 文字も入らない（そのファイルを import して実行するのと同じ信頼の範囲）。
  //      import できないのは、Workflow DSL のスクリプトがトップレベル await と DSL のグローバルに依存するため。
  //      テストの外・製品コードでこの書き方を使わないこと
  const factory = new Function(
    'LOGGABLE_AGENT_TYPES',
    'PROGRESS_LOGGABLE_AGENT_TYPES',
    'rawAgent',
    `let loggableAgentCount = 0
     let progressLoggableAgentCount = 0
     ${fnSource}
     return { trackedAgent, counts: () => ({ loop: loggableAgentCount, progress: progressLoggableAgentCount }) }`,
  )
  const launched = []
  const api = factory(
    new Set(['reviewer', 'implementer', 'judge-panel']),
    new Set(['reviewer', 'judge-panel', 'sweep-ui', 'adversarial-verify']),
    (prompt, opts) => {
      launched.push({ prompt, opts })
      return 'launched'
    },
  )
  return { ...api, launched }
}

describe('deep ワークフローの期待件数（trackedAgent）', () => {
  it('取り出した関数が本体まで含んでいる（引数の波括弧を本体と取り違えていない）', () => {
    const fnSource = extractDeclaration(SOURCE, 'trackedAgent')
    expect(fnSource).toContain('return rawAgent(prompt, opts)')
  })

  it('既定では、agentType に応じて起動のたびに数える（従来どおり）', () => {
    const { trackedAgent, counts } = loadTrackedAgent()
    trackedAgent('p', { agentType: 'reviewer' })
    trackedAgent('p', { agentType: 'judge-panel' })
    trackedAgent('p', { agentType: 'sweep-ui' })
    trackedAgent('p', { agentType: 'unknown-role' })
    expect(counts()).toEqual({ loop: 2, progress: 3 })
  })

  it('expectsLogs: false の起動は、loop・progress のどちらにも数えない', () => {
    const { trackedAgent, counts } = loadTrackedAgent()
    trackedAgent('p', { agentType: 'reviewer' }, { expectsLogs: false })
    expect(counts()).toEqual({ loop: 0, progress: 0 })
  })

  it('数えなくても起動はする。agent() へ渡す opts に、数え方の指定を混ぜない', () => {
    const { trackedAgent, launched } = loadTrackedAgent()
    const opts = { agentType: 'reviewer', label: 'capture-tree:before' }
    expect(trackedAgent('p', opts, { expectsLogs: false })).toBe('launched')
    expect(launched).toHaveLength(1)
    expect(launched[0].opts).toBe(opts)
    expect(Object.keys(launched[0].opts)).not.toContain('expectsLogs')
  })

  it('木の状態を取る補助役（capture-tree）は、数えない指定で起動している', () => {
    // WHY: 上の 3 本は関数の性質を見るだけ。実際にその指定を使っているかは呼び出し側を見ないと分からない。
    //      指定を消すと、また毎回「記録漏れ 2 件」が出る形に戻る
    const start = SOURCE.indexOf('const captureTreeState')
    const end = SOURCE.indexOf('const treeBefore')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = SOURCE.slice(start, end)
    expect(block).toContain("agentType: 'reviewer'")
    expect(block).toMatch(/\{\s*expectsLogs:\s*false\s*\}/)
  })
})
