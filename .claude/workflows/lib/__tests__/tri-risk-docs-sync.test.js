import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractDeclaration } from '../extract-declaration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const LIB_FILE = path.resolve(__dirname, '../router-risk.js')
const DOC_FILES = ['AGENTS.md', 'docs/agents/common.md']
const SECTION_HEADING = '## TRI/RISK 機械判定基準'

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

function extractSection(markdown, heading) {
  const lines = markdown.split('\n')
  const start = lines.findIndex(l => l.startsWith(heading))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break }
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
  const pathPrefixes = stringLiterals(extractDeclaration(libSource, 'RISK_PATH_PREFIXES'))
  const domainKeywords = stringLiterals(extractDeclaration(libSource, 'RISK_DOMAIN_KEYWORDS'))
  const fileNameRules = ['middleware.ts', 'proxy.ts']

  it('正本から接頭辞・ドメイン語を取り出せる（テスト自身の前提）', () => {
    expect(pathPrefixes.length).toBeGreaterThan(0)
    expect(domainKeywords.length).toBeGreaterThan(0)
    const isHighRiskPath = extractDeclaration(libSource, 'isHighRiskPath')
    for (const f of fileNameRules) expect(isHighRiskPath).toContain(f)
  })

  const sections = {}
  for (const rel of DOC_FILES) {
    const section = extractSection(readFileSync(path.join(REPO_ROOT, rel), 'utf-8'), SECTION_HEADING)
    sections[rel] = section

    it(`${rel} に「${SECTION_HEADING}」節がある`, () => {
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
})
