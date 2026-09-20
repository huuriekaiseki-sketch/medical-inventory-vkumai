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

function loadTrackedAgent(featureName = 'issue-000-sample') {
  // WHY(3 つ取り出す): trackedAgent は feature 名の行を足すために resolveFeatureName / buildFeatureLine を呼ぶ（issue #807）
  const fnSource = [
    extractDeclaration(SOURCE, 'resolveFeatureName'),
    extractDeclaration(SOURCE, 'buildFeatureLine'),
    extractDeclaration(SOURCE, 'trackedAgent'),
  ].join('\n')
  // WHY(new Function を使ってよい範囲): 埋め込むのは**このリポジトリ自身のワークフローのソース**だけで、
  //      外部の入力・利用者の入力は 1 文字も入らない（そのファイルを import して実行するのと同じ信頼の範囲）。
  //      import できないのは、Workflow DSL のスクリプトがトップレベル await と DSL のグローバルに依存するため。
  //      テストの外・製品コードでこの書き方を使わないこと
  const factory = new Function(
    'LOGGABLE_AGENT_TYPES',
    'PROGRESS_LOGGABLE_AGENT_TYPES',
    'rawAgent',
    'FEATURE_NAME',
    `let loggableAgentCount = 0
     let progressLoggableAgentCount = 0
     ${fnSource}
     return {
       trackedAgent,
       resolveFeatureName,
       buildFeatureLine,
       counts: () => ({ loop: loggableAgentCount, progress: progressLoggableAgentCount }),
     }`,
  )
  const launched = []
  const api = factory(
    new Set(['reviewer', 'implementer', 'judge-panel']),
    new Set(['reviewer', 'judge-panel', 'sweep-ui', 'adversarial-verify']),
    (prompt, opts) => {
      launched.push({ prompt, opts })
      return 'launched'
    },
    featureName,
  )
  return { ...api, launched }
}

describe('deep ワークフローの期待件数（trackedAgent）', () => {
  it('取り出した関数が本体まで含んでいる（引数の波括弧を本体と取り違えていない）', () => {
    const fnSource = extractDeclaration(SOURCE, 'trackedAgent')
    // WHY: 見たいのは「末尾の return まで取り出せているか」。return の行の文面は決め打ちしない
    //      （issue #807 で引数が変わったときに、取り出しは正しいのにこのテストだけが落ちた）
    expect(fnSource).toMatch(/return rawAgent\(/)
    expect(fnSource.trimEnd().endsWith('}')).toBe(true)
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

// WHY(issue #807): deep ワークフローは feature 名を受け取らず、各エージェントにも渡していなかったので、
//      記録の `--feature` を**各エージェントが自分で作っていた**。2026-09-20 の 1 回の実行（81 体）で 15 種類
//      （`issue-809-order-detail` / `order-detail` / `issue #809` / `order-detail-809` …）。feature 別の集計が成り立たない。
//      全起動が trackedAgent を通るので、各プロンプトの文面を 1 つずつ書き換えず、ラッパーの 1 か所で足す
//      （役を足したときに、足し忘れる道が無い）。
describe('deep ワークフローの feature 名（trackedAgent が全役のプロンプトへ足す）', () => {
  it('記録する役のプロンプトの末尾に、使う feature 名が入る', () => {
    const { trackedAgent, launched } = loadTrackedAgent('issue-809-order-detail')
    trackedAgent('元のプロンプト', { agentType: 'reviewer' })
    expect(launched[0].prompt.startsWith('元のプロンプト')).toBe(true)
    expect(launched[0].prompt).toContain('--feature "issue-809-order-detail"')
    expect(launched[0].prompt).toContain('自分で名前を作らない')
  })

  it('記録しない役（expectsLogs: false）のプロンプトには足さない（結果だけ返す役に、要らない指示を混ぜない）', () => {
    const { trackedAgent, launched } = loadTrackedAgent('issue-809-order-detail')
    trackedAgent('元のプロンプト', { agentType: 'reviewer' }, { expectsLogs: false })
    expect(launched[0].prompt).toBe('元のプロンプト')
  })

  it('どの役にも同じ行が入る（役ごとに別の名前にならない）', () => {
    const { trackedAgent, launched } = loadTrackedAgent('issue-809-order-detail')
    for (const agentType of ['reviewer', 'judge-panel', 'sweep-ui', 'adversarial-verify', 'unknown-role']) {
      trackedAgent('p', { agentType })
    }
    const tails = new Set(launched.map((l) => l.prompt.slice(1)))
    expect(tails.size).toBe(1)
  })

  describe('resolveFeatureName: 受け取った名前を、シェルの引数として安全な形にだけ通す', () => {
    // WHY: この名前はエージェントが `--feature "<名前>"` としてシェルへ渡す。引用符・バッククォート・$() を含む名前を
    //      そのまま渡すと、記録のコマンドが壊れる（か、別のコマンドとして解釈される）。通すのは英数字と . _ - だけ
    const { resolveFeatureName } = loadTrackedAgent()

    it('英数字と . _ - だけの名前はそのまま通す', () => {
      expect(resolveFeatureName('issue-809-order-detail')).toBe('issue-809-order-detail')
      expect(resolveFeatureName('lot_search.v2')).toBe('lot_search.v2')
    })

    it('未指定・空・文字列でない値は unknown（各エージェントに名前を作らせない）', () => {
      for (const v of [undefined, null, '', '   ', 42, {}]) {
        expect(resolveFeatureName(v)).toBe('unknown')
      }
    })

    it('シェルで意味を持つ文字・空白・日本語を含む名前は unknown に倒す（直して通さない）', () => {
      for (const v of ['a"; rm -rf x; "', 'a`id`', 'a$(id)', 'issue #809', 'ロット検索', 'a b', "a'b", 'a\nb']) {
        expect(resolveFeatureName(v)).toBe('unknown')
      }
    })

    it('長すぎる名前は unknown（64 字まで）', () => {
      expect(resolveFeatureName('a'.repeat(64))).toBe('a'.repeat(64))
      expect(resolveFeatureName('a'.repeat(65))).toBe('unknown')
    })
  })

  it('足す行は、eval が測るプロンプト（lib/prompts/*.js）の外側で足す', () => {
    // WHY: 2026-09-21 に確かめた事実の記録。eval（eval-workflow-prompts / eval-sweep-recall）は
    //      `lib/prompts/*.js` の関数を直接呼んでプロンプトを組み立てるので、**このラッパーを通らない**。
    //      つまり feature 名の行は eval の測定対象に入らない（eval を回しても、この変更は測れない）。
    //      逆に、行を lib/prompts/ 側へ移すと eval の入力が変わって過去の記録と比べられなくなるので、
    //      **外側で足す**という判断をここで固定する。移したくなったら、この行と一緒に eval の扱いを考え直すこと
    const sweepPrompt = readFileSync(join(__dirname, '../prompts/sweep.js'), 'utf-8')
    expect(sweepPrompt).not.toContain('記録に使う feature 名')
    expect(SOURCE).toContain('記録に使う feature 名')
  })

  it('ワークフローは args.feature を読み、router は deep へ feature を渡す', () => {
    expect(SOURCE).toMatch(/resolveFeatureName\(parsedArgs\?\.feature\)/)
    const router = readFileSync(join(__dirname, '../../aidd-phase1-router.js'), 'utf-8')
    expect(router).toMatch(/workflow\('aidd-1-1-deep-task',\s*\{[^}]*\bfeature\b[^}]*\}\)/)
  })
})
