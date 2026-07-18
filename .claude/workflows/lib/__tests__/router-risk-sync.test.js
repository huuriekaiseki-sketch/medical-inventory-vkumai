import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROUTER_FILE = path.resolve(__dirname, '../../aidd-phase1-router.js')
const LIB_FILE = path.resolve(__dirname, '../router-risk.js')

// router-risk.js（正本、vitestでテスト可能）とaidd-phase1-router.js（Workflow DSL、
// require不可のためインライン複製）の判定ロジックが乖離していないかを検証する（issue #456）。
// judge-panel.js等と異なり、この判定ロジックは一度ドリフトすると「否定文脈の誤判定」のような
// 静かなコスト増を招くため（issue #456自体がその実例）、軽量なsync testを設けた。
// テンプレートリテラルの抽出（sweep-prompt-sync.test.js）とは異なりロジックの一部なので、
// 判定式・定数配列の文字列を素朴に抽出して比較する簡易チェックに留める。
function extractArray(source, varName) {
  const match = source.match(new RegExp(`const ${varName} = (\\[[^\\]]*\\])`, 's'))
  return match ? match[1] : null
}

describe('router-risk.jsとaidd-phase1-router.jsの判定ロジック同期(issue #456)', () => {
  it('isHighRisk判定式（changedFiles提供時はmatchedPathsのみで判定する式）が両ファイルに同じ形で存在する', () => {
    const routerSource = readFileSync(ROUTER_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')
    const CORE_LOGIC = 'hasChangedFiles ? matchedPaths.length > 0 : matchedKeywords.length > 0'

    expect(routerSource).toContain(CORE_LOGIC)
    expect(libSource).toContain(CORE_LOGIC)
  })

  it('RISK_DOMAIN_KEYWORDSが両ファイルで同じ内容', () => {
    const routerSource = readFileSync(ROUTER_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')

    expect(extractArray(routerSource, 'RISK_DOMAIN_KEYWORDS')).toBe(extractArray(libSource, 'RISK_DOMAIN_KEYWORDS'))
  })

  it('RISK_PATH_PREFIXESが両ファイルで同じ内容', () => {
    const routerSource = readFileSync(ROUTER_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')

    expect(extractArray(routerSource, 'RISK_PATH_PREFIXES')).toBe(extractArray(libSource, 'RISK_PATH_PREFIXES'))
  })

  it('META_PATH_PREFIXESが両ファイルで同じ内容（issue #457）', () => {
    const routerSource = readFileSync(ROUTER_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')

    expect(extractArray(routerSource, 'META_PATH_PREFIXES')).toBe(extractArray(libSource, 'META_PATH_PREFIXES'))
  })

  it('isMetaModification判定式（isHighRiskより優先する式）が両ファイルに同じ形で存在する（issue #457）', () => {
    const routerSource = readFileSync(ROUTER_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')
    const META_LOGIC = 'hasChangedFiles && changedFiles.every(isMetaPath)'
    const RISK_WITH_META_LOGIC = 'isMetaModification ? false : hasChangedFiles ? matchedPaths.length > 0 : matchedKeywords.length > 0'

    // lib側はローカル変数名がchangedFilesではなく引数(changedFiles ?? [])のため、
    // メタ判定式のみ表記が異なる。式の意味的な同一性は router-risk.test.js のテストケース
    // （router-risk.jsの単体テスト）とaidd-phase1-router.jsの手動レビューで担保する。
    expect(routerSource).toContain(META_LOGIC)
    expect(routerSource).toContain(RISK_WITH_META_LOGIC)
    expect(libSource).toContain(RISK_WITH_META_LOGIC)
  })
})
