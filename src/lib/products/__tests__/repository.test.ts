import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { listProducts } from '../repository'

// WHY: compatibilities/__tests__/repository.test.ts と同様、本物のPostgRESTには接続せず、
// .or()/.order()に渡された条件式を簡易パーサで解釈し、mockのdataに同じ絞り込みロジックを
// 適用することで「DBクエリ構築で完結しているか」を単体テストで検証する。
// WHY: .or()式内のilike値はダブルクォートで囲まれ、値自体にカンマを含みうる
// （buildIlikeValueの仕様）。単純な split(',') では引用符内のカンマまで区切ってしまうため、
// 引用符の外側にあるカンマだけを区切りとして扱う。
function splitOrExpr(orExpr: string): string[] {
  const conditions: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < orExpr.length; i++) {
    const ch = orExpr[i]
    if (ch === '"' && orExpr[i - 1] !== '\\') inQuotes = !inQuotes
    if (ch === ',' && !inQuotes) {
      conditions.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) conditions.push(current)
  return conditions
}

function matchesOrExpr(row: Record<string, unknown>, orExpr: string): boolean {
  const conditions = splitOrExpr(orExpr)
  return conditions.some((condition) => {
    const parts = condition.split('.')
    const pattern = parts.pop() as string
    const op = parts.pop() as string
    const col = parts.pop() as string
    if (op !== 'ilike') return false
    const value = row[col]
    if (typeof value !== 'string') return false
    const unquoted = pattern.startsWith('"') && pattern.endsWith('"') ? pattern.slice(1, -1) : pattern
    const kw = unquoted.replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase()
    return value.toLowerCase().includes(kw)
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeChainableQuery(result: { data: unknown; error: unknown }): any {
  let orExpr: string | undefined
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    order: vi.fn(() => builder),
    or: vi.fn((expr: string) => {
      orExpr = expr
      return builder
    }),
    then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
      if (result.error || !Array.isArray(result.data)) return resolve(result)
      let rows = result.data as Record<string, unknown>[]
      if (orExpr) rows = rows.filter((r) => matchesOrExpr(r, orExpr as string))
      return resolve({ data: rows, error: null })
    },
  }
  return builder
}

function makeMockListDb(result: { data: unknown; error: unknown }) {
  const query = makeChainableQuery(result)
  const db = { from: vi.fn(() => query) } as unknown as SupabaseClient
  return { db, query }
}

const productA = {
  id: 'p-1', jan: '1111111111111', ref: 'REF-A', name: 'カテーテルA型', maker: 'テルモ',
  created_at: '2026-07-14T00:00:00Z', updated_at: '2026-07-14T00:00:00Z',
}
const productB = {
  id: 'p-2', jan: '2222222222222', ref: 'REF-B', name: '縫合糸B型', maker: 'ニプロ',
  created_at: '2026-07-13T00:00:00Z', updated_at: '2026-07-13T00:00:00Z',
}

describe('listProducts', () => {
  it('filter未指定時は全件を返す（後方互換）', async () => {
    const { db, query } = makeMockListDb({ data: [productA, productB], error: null })
    const result = await listProducts(db)
    expect(result).toHaveLength(2)
    expect(query.or).not.toHaveBeenCalled()
  })

  it('keyword未指定のfilterでも全件を返す', async () => {
    const { db } = makeMockListDb({ data: [productA, productB], error: null })
    const result = await listProducts(db, {})
    expect(result).toHaveLength(2)
  })

  it('keywordがnameに一致する行のみ返す', async () => {
    const { db } = makeMockListDb({ data: [productA, productB], error: null })
    const result = await listProducts(db, { keyword: 'カテーテル' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('p-1')
  })

  it('keywordがmakerに一致する行のみ返す', async () => {
    const { db } = makeMockListDb({ data: [productA, productB], error: null })
    const result = await listProducts(db, { keyword: 'ニプロ' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('p-2')
  })

  it('keywordの大文字小文字を区別しない', async () => {
    const englishMaker = { ...productA, id: 'p-4', maker: 'Terumo' }
    const { db } = makeMockListDb({ data: [englishMaker, productB], error: null })
    const result = await listProducts(db, { keyword: 'terumo' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('p-4')
  })

  it('keywordがjanに一致する行のみ返す', async () => {
    const { db } = makeMockListDb({ data: [productA, productB], error: null })
    const result = await listProducts(db, { keyword: '2222222222222' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('p-2')
  })

  it('keywordがrefに一致する行のみ返す', async () => {
    const { db } = makeMockListDb({ data: [productA, productB], error: null })
    const result = await listProducts(db, { keyword: 'REF-A' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('p-1')
  })

  it('keywordに%・_・,が含まれても正しくエスケープされて検索される', async () => {
    const special = { ...productA, id: 'p-3', name: '100%_テスト,製品' }
    const { db } = makeMockListDb({ data: [special, productB], error: null })
    const result = await listProducts(db, { keyword: '100%_テスト,製品' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('p-3')
  })

  it('該当なしの場合は空配列を返す', async () => {
    const { db } = makeMockListDb({ data: [productA, productB], error: null })
    const result = await listProducts(db, { keyword: '存在しないキーワード' })
    expect(result).toHaveLength(0)
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const { db } = makeMockListDb({ data: null, error: { message: 'DB error: table products' } })
    await expect(listProducts(db)).rejects.toThrow()
  })
})
