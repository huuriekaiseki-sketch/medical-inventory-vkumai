import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { classifyCoverage, unmatchedItems } from '../coverage-check.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_FILE = path.resolve(__dirname, '../../aidd-phase2.js')

describe('classifyCoverage(issue R03)', () => {
  it('SPEC.md しか変わっていなければ hasChanges は false', () => {
    const r = classifyCoverage(['SPEC.md'], 'SPEC.md')
    expect(r.hasChanges).toBe(false)
    expect(r.excluded).toEqual(['SPEC.md'])
    expect(r.implementationFiles).toEqual([])
  })

  it('絶対パスで渡された SPEC も除外する（specPath は絶対パス推奨）', () => {
    const r = classifyCoverage(['SPEC.md'], '/Users/x/repo/SPEC.md')
    expect(r.hasChanges).toBe(false)
  })

  it('実行の記録・ログしか変わっていなければ hasChanges は false', () => {
    const r = classifyCoverage(['.aidd/run-manifest.json', 'logs/agent-progress.jsonl'], 'SPEC.md')
    expect(r.hasChanges).toBe(false)
    expect(r.implementationFiles).toEqual([])
  })

  it('実装物が1件でもあれば hasChanges は true', () => {
    const r = classifyCoverage(['SPEC.md', '.aidd/run-manifest.json', 'src/lib/foo.ts'], 'SPEC.md')
    expect(r.hasChanges).toBe(true)
    expect(r.implementationFiles).toEqual(['src/lib/foo.ts'])
    expect(r.excluded).toEqual(['SPEC.md', '.aidd/run-manifest.json'])
  })

  it('新しい migration は実装物として数える', () => {
    const r = classifyCoverage(['supabase/migrations/20260910_new.sql'], 'SPEC.md')
    expect(r.hasChanges).toBe(true)
  })

  it('docs/ は実装物として数える（除外を広げない）', () => {
    // 除外を広げるほど「実装したことにならない変更」が増える。迷ったら数える側へ倒す
    const r = classifyCoverage(['docs/agents/decisions.md'], 'SPEC.md')
    expect(r.hasChanges).toBe(true)
  })

  it('空・未指定なら hasChanges は false', () => {
    expect(classifyCoverage([], 'SPEC.md').hasChanges).toBe(false)
    expect(classifyCoverage(undefined, 'SPEC.md').hasChanges).toBe(false)
  })
})

describe('unmatchedItems(issue R03)', () => {
  it('実装物が対応しない項目を名指しする', () => {
    const items = [
      { item: '発注の取り消し API', files: ['src/app/api/orders/route.ts'] },
      { item: '取り消しの画面', files: [] },
      { item: '取り消しの RLS', files: [] },
    ]
    expect(unmatchedItems(items)).toEqual(['取り消しの画面', '取り消しの RLS'])
  })

  it('全項目に実装物があれば空', () => {
    expect(unmatchedItems([{ item: 'a', files: ['x.ts'] }])).toEqual([])
  })

  it('items が空・未指定でも落ちない', () => {
    expect(unmatchedItems([])).toEqual([])
    expect(unmatchedItems(undefined)).toEqual([])
  })
})

// この lib は実行パスに配線されていない（実際に動くのはプロンプト）。
// 純粋関数だけ直しても実行は変わらないので、プロンプト側の要求も文字列で見張る。
describe('Coverage Check のプロンプトが実装物と仕様書を分けている(issue R03)', () => {
  const source = readFileSync(WORKFLOW_FILE, 'utf-8')

  it('仕様書・記録・ログを除外する指示がある', () => {
    expect(source).toContain('実装物でないもの')
    expect(source).toContain('.aidd/ 配下')
    expect(source).toContain('logs/ 配下')
  })

  it('実装項目ごとの対応（担当・成果・検証）を求めている', () => {
    expect(source).toContain('実装項目ごとに')
    expect(source).toContain('何で検証されるか')
    expect(source).toContain('unmatchedItems')
  })

  it('schema が items / unmatchedItems を持つ', () => {
    expect(source).toContain('unmatchedItems: { type: \'array\'')
    expect(source).toContain('verification: { type: \'string\' }')
  })
})
