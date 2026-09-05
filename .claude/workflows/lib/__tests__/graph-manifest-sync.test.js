import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractDeclaration } from '../extract-declaration.js'
import { GRAPH } from '../../graph/aidd-graph.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOWS_DIR = path.resolve(__dirname, '../..')

// WHY: グラフマニフェスト（.claude/workflows/graph/aidd-graph.mjs、issue #710）と各 Workflow DSL
// （require 不可のため静的抽出）が乖離していないかを npm test で検査する。プロンプト文言の
// workflow-prompt-sync / router-risk-sync と同型の「正本 vs 実装」ガード。
//
// 突合するもの（Workflow ごと）:
//   1. phase('X') の集合 == マニフェスト nodes の phase 集合
//   2. agentType: 'x' の集合 == マニフェスト nodes の agentType 集合
//   3. blockedAt 文字列（リテラル + tokenCapReturn('X') → 'Token Cap (before X)'）の集合
//      == マニフェスト edges の blockedAt 集合
//   4. 予算定数（const NAME = 数値）とマニフェスト budgets の一致
//   5. fan-out 数（REVIEW_DIMENSIONS / FINDERS / PROPOSERS の要素数）とマニフェストの一致
// マニフェスト自身の整合（blocked エッジは必ず returnsTo を持つ、エッジの端点が nodes に存在）も見る。

const extractSet = (source, regex) => {
  const set = new Set()
  for (const m of source.matchAll(regex)) set.add(m[1])
  return set
}

function extractBlockedAt(source) {
  const set = extractSet(source, /blockedAt:\s*'([^']+)'/g)
  for (const m of source.matchAll(/tokenCapReturn\('([^']+)'/g)) set.add(`Token Cap (before ${m[1]})`)
  // tokenCapReturn の定義内テンプレート `Token Cap (before ${blockedAt})` は具体値ではないので除外
  set.delete('Token Cap (before ${blockedAt})')
  return set
}

function extractNumberConst(source, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*([0-9_]+)`).exec(source)
  return m ? Number(m[1].replace(/_/g, '')) : null
}

function countEntries(declSource, key) {
  return [...declSource.matchAll(new RegExp(`\\b${key}:`, 'g'))].length
}

const sorted = set => [...set].sort()

describe('グラフマニフェストと Workflow DSL の同期（issue #710）', () => {
  for (const [name, wf] of Object.entries(GRAPH.workflows)) {
    const source = readFileSync(path.join(WORKFLOWS_DIR, wf.file), 'utf-8')
    const manifestPhases = new Set(wf.nodes.map(n => n.phase))
    const manifestAgentTypes = new Set(wf.nodes.map(n => n.agentType).filter(Boolean))
    const manifestBlockedAt = new Set(wf.edges.map(e => e.blockedAt).filter(Boolean))

    describe(name, () => {
      it("phase('X') の集合がマニフェストの phase 集合と一致する", () => {
        expect(sorted(extractSet(source, /phase\('([^']+)'\)/g))).toEqual(sorted(manifestPhases))
      })

      it("agentType: 'x' の集合がマニフェストの agentType 集合と一致する", () => {
        expect(sorted(extractSet(source, /agentType:\s*'([^']+)'/g))).toEqual(sorted(manifestAgentTypes))
      })

      it('blockedAt の集合がマニフェストの blocked/token-cap エッジと一致する', () => {
        expect(sorted(extractBlockedAt(source))).toEqual(sorted(manifestBlockedAt))
      })

      for (const key of ['DEFAULT_TOKEN_CAP', 'MAX_REVIEW_RETRIES', 'MIN_BUDGET_FOR_SWEEP_ROUND']) {
        const jsValue = extractNumberConst(source, key)
        if (jsValue !== null || key in wf.budgets) {
          it(`予算定数 ${key} がマニフェストと一致する`, () => {
            expect(wf.budgets[key]).toBe(jsValue)
          })
        }
      }

      it('blocked / token-cap エッジは必ず returnsTo（復帰先）を持つ', () => {
        for (const e of wf.edges.filter(e => e.blockedAt)) {
          expect(e.returnsTo, `${name}: ${e.blockedAt}`).toBeTruthy()
          const ok = e.returnsTo === 'human' || e.returnsTo === 'resumeFromRunId' || e.returnsTo in GRAPH.humanGates
          expect(ok, `${name}: ${e.blockedAt} → ${e.returnsTo}`).toBe(true)
        }
      })

      it('エッジの端点はすべて nodes に存在する', () => {
        const ids = new Set(wf.nodes.map(n => n.id))
        for (const e of wf.edges) {
          expect(ids.has(e.from), `${name}: from=${e.from}`).toBe(true)
          expect(ids.has(e.to), `${name}: to=${e.to}`).toBe(true)
        }
      })
    })
  }

  describe('fan-out 数', () => {
    const phase2 = readFileSync(path.join(WORKFLOWS_DIR, 'aidd-phase2.js'), 'utf-8')
    const deep = readFileSync(path.join(WORKFLOWS_DIR, 'aidd-1-1-deep-task.js'), 'utf-8')

    it('REVIEW_DIMENSIONS の要素数 == budgets.reviewDimensions == review ノードの fanout', () => {
      const n = countEntries(extractDeclaration(phase2, 'REVIEW_DIMENSIONS'), 'key')
      expect(GRAPH.workflows['aidd-phase2'].budgets.reviewDimensions).toBe(n)
      expect(GRAPH.workflows['aidd-phase2'].nodes.find(x => x.id === 'review').fanout).toBe(n)
    })

    it('FINDERS の要素数 == budgets.finders == find ノードの fanout', () => {
      const n = countEntries(extractDeclaration(deep, 'FINDERS'), 'lens')
      expect(GRAPH.workflows['aidd-1-1-deep-task'].budgets.finders).toBe(n)
      expect(GRAPH.workflows['aidd-1-1-deep-task'].nodes.find(x => x.id === 'find').fanout).toBe(n)
    })

    it('PROPOSERS の要素数 == budgets.proposers、採点は proposers × scoreLenses', () => {
      const n = countEntries(extractDeclaration(deep, 'PROPOSERS'), 'stance')
      const b = GRAPH.workflows['aidd-1-1-deep-task'].budgets
      expect(b.proposers).toBe(n)
      expect(GRAPH.workflows['aidd-1-1-deep-task'].nodes.find(x => x.id === 'score').fanout).toBe(n * b.scoreLenses)
    })
  })

  describe('RED 方向の自己検証', () => {
    it('phase を 1 つ消したマニフェストは一致しない', () => {
      const source = readFileSync(path.join(WORKFLOWS_DIR, 'aidd-phase2.js'), 'utf-8')
      const tampered = GRAPH.workflows['aidd-phase2'].nodes.filter(n => n.phase !== 'Integrate')
      expect(sorted(extractSet(source, /phase\('([^']+)'\)/g))).not.toEqual(sorted(new Set(tampered.map(n => n.phase))))
    })
    it('blockedAt を 1 つ変えたマニフェストは一致しない', () => {
      const source = readFileSync(path.join(WORKFLOWS_DIR, 'aidd-phase2.js'), 'utf-8')
      const tampered = GRAPH.workflows['aidd-phase2'].edges.map(e => (e.blockedAt === 'Review' ? { ...e, blockedAt: 'Review!' } : e))
      expect(sorted(extractBlockedAt(source))).not.toEqual(sorted(new Set(tampered.map(e => e.blockedAt).filter(Boolean))))
    })
    it('予算定数を変えたマニフェストは一致しない', () => {
      const source = readFileSync(path.join(WORKFLOWS_DIR, 'aidd-phase2.js'), 'utf-8')
      expect(extractNumberConst(source, 'MAX_REVIEW_RETRIES')).not.toBe(GRAPH.workflows['aidd-phase2'].budgets.MAX_REVIEW_RETRIES + 1)
    })
  })
})
