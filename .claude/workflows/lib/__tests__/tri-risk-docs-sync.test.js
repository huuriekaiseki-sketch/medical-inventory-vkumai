import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractDeclaration } from '../extract-declaration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const LIB_FILE = path.resolve(__dirname, '../router-risk.js')
const DOC_FILES = ['AGENTS.md', 'docs/agents/common.md']
// WHY(見出しレベルを固定しない): 2026-09-07 に common.md を分野ごとに再構成した際、
// この節が `##` から `###`（分野「作業を始める前に」の下）へ下がり、`'## TRI/RISK 機械判定基準'`
// の前方一致が外れて section が null になった（本テストが 14 件落ちて検知した）。
// 本テストが守っているのは **AGENTS.md と common.md の内容が食い違わないこと**であって、
// 見出しの深さではない。深さに依存しない形にする（保証は変えない。下の RED 方向の自己検証が残る）。
const SECTION_TITLE = 'TRI/RISK 機械判定基準'

// WHY: TRI/RISK 機械判定基準（高リスクパス・ドメイン語）は、Claude Code が読む
// docs/agents/common.md（CLAUDE.md から @import）と Codex が読む AGENTS.md の両方に本文として
// 存在する。Claude/Codex 共存設計（docs/agents/parallel-agent-work.md）は「2つのコピーが
// 食い違ったとき必ずバグになるもの」の共有を認めており、TRI/RISK 基準はまさにそれに当たるが、
// これまで同期テストが無く、issue #681（proxy.ts 追加）のような基準変更で片方だけ更新される
// 事故が構造的に起こりえた（issue #715）。
//
// 正本は .claude/workflows/lib/router-risk.js（RISK_PATH_PREFIXES / RISK_DOMAIN_KEYWORDS /
// isHighRiskPath 内の middleware.ts・proxy.ts 判定）。本テストは
//   1. 両 doc の TRI/RISK 節に、正本の全パス接頭辞・middleware.ts・proxy.ts・全ドメイン語が
//      含まれること（正本 → doc の片方向）
//   2. 両 doc の TRI/RISK 節の「基準本体」（箇条書き〜「迷ったら高リスク側に倒す」まで）が
//      一字一句一致すること（doc 同士のドリフト検知）
// を検証する。AGENTS.md をポインタ化して重複を無くす案（issue #715 案A）は、Codex が起動時に
// 読む本文から常時ルールが消えるため採らなかった（docs/agents/decisions.md）。

/**
 * 見出しの深さに依存せず節を切り出す。
 * 開始は `##`〜`######` のいずれかで title が始まる行、終わりは**同じか浅い**次の見出し。
 * （`###` の節なら `####` の小見出しは中に含み、次の `###` / `##` で切れる）
 */
function extractSection(markdown, title) {
  const lines = markdown.split('\n')
  const headingRe = /^(#{2,6}) (.*)$/
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe)
    if (m && m[2].startsWith(title)) { start = i; level = m[1].length; break }
  }
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(headingRe)
    if (m && m[1].length <= level) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

// 基準本体: 「変更が以下の」で始まる段落から「迷ったら高リスク側に倒す」を含む行まで
function extractRuleCore(section) {
  const lines = section.split('\n')
  const start = lines.findIndex(l => l.startsWith('変更が以下の'))
  const end = lines.findIndex(l => l.includes('迷ったら高リスク側に倒す'))
  if (start < 0 || end < 0 || end < start) return null
  return lines.slice(start, end + 1).join('\n')
}

function stringLiterals(declSource) {
  return [...declSource.matchAll(/'([^']+)'/g)].map(m => m[1])
}

describe('TRI/RISK 機械判定基準の AGENTS.md / common.md と router-risk.js の同期（issue #715）', () => {
  const libSource = readFileSync(LIB_FILE, 'utf-8')
  // issue #420 v1 セット B: 固有語彙は aidd.config.json（導入先アダプター）へ移った。docs に
  // 書くべき基準は「汎用既定値（router-risk.js の DEFAULT_RISK_CONFIG）＋ vkumai の設定」の和。
  // 'migration' は既定の domainKeywords にあるが docs の基準本文は `supabase/migrations/` 接頭辞で
  // 表現しているため、docs 側の照合は設定ファイルの値で行い、既定値は存在確認のみにする
  const riskConfig = JSON.parse(readFileSync(path.join(REPO_ROOT, 'aidd.config.json'), 'utf-8')).risk
  const pathPrefixes = riskConfig.pathPrefixes
  const domainKeywords = riskConfig.domainKeywords
  const defaultDomainKeywords = stringLiterals(
    extractDeclaration(libSource, 'DEFAULT_RISK_CONFIG').match(/domainKeywords:\s*\[[^\]]*\]/)[0]
  )
  const fileNameRules = ['middleware.ts', 'proxy.ts']

  it('正本から接頭辞・ドメイン語を取り出せる（テスト自身の前提）', () => {
    expect(pathPrefixes.length).toBeGreaterThan(0)
    expect(domainKeywords.length).toBeGreaterThan(0)
    const isHighRiskPath = extractDeclaration(libSource, 'isHighRiskPath')
    for (const f of fileNameRules) expect(isHighRiskPath).toContain(f)
  })

  it('汎用既定値のドメイン語（migration を除く）は vkumai の設定にも含まれる（設定が既定値を狭めない）', () => {
    for (const kw of defaultDomainKeywords.filter(k => k !== 'migration')) {
      expect(domainKeywords).toContain(kw)
    }
  })

  const sections = {}
  for (const rel of DOC_FILES) {
    const section = extractSection(readFileSync(path.join(REPO_ROOT, rel), 'utf-8'), SECTION_TITLE)
    sections[rel] = section

    it(`${rel} に「${SECTION_TITLE}」節がある（見出しの深さは問わない）`, () => {
      expect(section).not.toBeNull()
    })

    for (const prefix of pathPrefixes) {
      it(`${rel} の TRI/RISK 節に高リスクパス接頭辞 ${prefix} がある`, () => {
        expect(section).toContain(prefix)
      })
    }
    for (const f of fileNameRules) {
      it(`${rel} の TRI/RISK 節にファイル名規則 ${f} がある`, () => {
        expect(section).toContain(f)
      })
    }
    for (const kw of domainKeywords) {
      it(`${rel} の TRI/RISK 節にドメイン語 ${kw} がある（大文字小文字不問）`, () => {
        expect(section.toLowerCase()).toContain(kw.toLowerCase())
      })
    }
  }

  it('AGENTS.md と common.md の基準本体（箇条書き〜「迷ったら高リスク側に倒す」）が一字一句一致する', () => {
    const cores = DOC_FILES.map(rel => extractRuleCore(sections[rel]))
    for (const core of cores) expect(core).not.toBeNull()
    expect(cores[0]).toBe(cores[1])
  })

  it('RED 方向: 片方の節から proxy.ts を消すと不一致を検知する（テスト自身の自己検証）', () => {
    const tampered = sections['AGENTS.md'].replaceAll('proxy.ts', 'prox_y.ts')
    expect(extractRuleCore(tampered)).not.toBe(extractRuleCore(sections['docs/agents/common.md']))
    expect(tampered).not.toContain('proxy.ts')
  })

  // WHY(2026-09-07): 節の見出しを `##` から `###` へ下げただけで extractSection が null を返し、
  //      本テストが 14 件落ちた。抽出の前提（見出しの深さ）が暗黙だったため、
  //      doc を整理するたびに同じことが起きる。切り出し自体をここで固定する。
  describe('extractSection の切り出し（見出しの深さに依存しない）', () => {
    const doc = [
      '# タイトル', '', '## 分野A', '', 'リード', '',
      '### 対象の節', '', '本文1', '',
      '#### 小見出し', '', '本文2', '',
      '### 次の節', '', '入ってはいけない', '',
      '## 分野B', '', '入ってはいけない', '',
    ].join('\n')

    it('`###` の節でも切り出せる', () => {
      expect(extractSection(doc, '対象の節')).not.toBeNull()
    })

    it('より深い小見出し（`####`）は節の中に含む', () => {
      const s = extractSection(doc, '対象の節')
      expect(s).toContain('本文2')
      expect(s).toContain('#### 小見出し')
    })

    it('同じ深さの次の見出しで切れる（後続の節を飲み込まない）', () => {
      expect(extractSection(doc, '対象の節')).not.toContain('入ってはいけない')
    })

    it('`##` の節でも同じように切り出せる（AGENTS.md 側の形）', () => {
      const s = extractSection(doc, '分野A')
      expect(s).toContain('本文2')
      expect(s).not.toContain('## 分野B')
    })

    it('無い節は null を返す', () => {
      expect(extractSection(doc, '存在しない節')).toBeNull()
    })
  })
})
