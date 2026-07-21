import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { listDistributorProducts } from '../repository'

// WHY: products/__tests__/repository.test.ts と同様、.or()/.eq()に渡された条件を
// 簡易パーサ/フィルタで模倣し、DBクエリ構築で完結しているかを単体テストで検証する。
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
  const eqFilters: { col: string; val: unknown }[] = []
  let orExpr: string | undefined
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    eq: vi.fn((col: string, val: unknown) => {
      eqFilters.push({ col, val })
      return builder
    }),
    order: vi.fn(() => builder),
    or: vi.fn((expr: string) => {
      orExpr = expr
      return builder
    }),
    then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
      if (result.error || !Array.isArray(result.data)) return resolve(result)
      let rows = result.data as Record<string, unknown>[]
      for (const { col, val } of eqFilters) rows = rows.filter((r) => r[col] === val)
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

const itemA = {
  id: 'dp-1', product_id: 'p-1', maker: 'テルモ', supplier: '仕入先A', name: 'カテーテルA型',
  reimbursement_price: 1000, quantity: 10, category_id: 'cat-1',
  created_at: '2026-07-14T00:00:00Z', updated_at: '2026-07-14T00:00:00Z',
}
const itemB = {
  id: 'dp-2', product_id: 'p-2', maker: 'ニプロ', supplier: '仕入先B', name: '縫合糸B型',
  reimbursement_price: null, quantity: 5, category_id: 'cat-2',
  created_at: '2026-07-13T00:00:00Z', updated_at: '2026-07-13T00:00:00Z',
}

describe('listDistributorProducts', () => {
  it('filter未指定時は全件を返す（後方互換）', async () => {
    const { db, query } = makeMockListDb({ data: [itemA, itemB], error: null })
    const result = await listDistributorProducts(db)
    expect(result).toHaveLength(2)
    expect(query.or).not.toHaveBeenCalled()
    expect(query.eq).not.toHaveBeenCalled()
  })

  it('keywordがnameに一致する行のみ返す', async () => {
    const { db } = makeMockListDb({ data: [itemA, itemB], error: null })
    const result = await listDistributorProducts(db, { keyword: 'カテーテル' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('dp-1')
  })

  it('keywordがmakerに一致する行のみ返す', async () => {
    const { db } = makeMockListDb({ data: [itemA, itemB], error: null })
    const result = await listDistributorProducts(db, { keyword: 'ニプロ' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('dp-2')
  })

  it('keywordがsupplierに一致する行のみ返す（大文字小文字を無視）', async () => {
    const englishSupplier = { ...itemA, id: 'dp-3', supplier: 'SupplierX' }
    const { db } = makeMockListDb({ data: [englishSupplier, itemB], error: null })
    const result = await listDistributorProducts(db, { keyword: 'supplierx' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('dp-3')
  })

  it('keywordに%・_・,が含まれても正しくエスケープされて検索される', async () => {
    const special = { ...itemA, id: 'dp-4', name: '100%_テスト,商品' }
    const { db } = makeMockListDb({ data: [special, itemB], error: null })
    const result = await listDistributorProducts(db, { keyword: '100%_テスト,商品' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('dp-4')
  })

  it('categoryIdフィルタ単体で完全一致絞り込みする', async () => {
    const { db, query } = makeMockListDb({ data: [itemA, itemB], error: null })
    const result = await listDistributorProducts(db, { categoryId: 'cat-1' })
    expect(query.eq).toHaveBeenCalledWith('category_id', 'cat-1')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('dp-1')
  })

  it('keyword + categoryIdのAND絞り込みが機能する', async () => {
    const { db } = makeMockListDb({ data: [itemA, itemB], error: null })
    const result = await listDistributorProducts(db, { keyword: 'カテーテル', categoryId: 'cat-1' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('dp-1')
  })

  it('keyword + categoryIdでAND不一致なら0件を返す', async () => {
    const { db } = makeMockListDb({ data: [itemA, itemB], error: null })
    const result = await listDistributorProducts(db, { keyword: 'カテーテル', categoryId: 'cat-2' })
    expect(result).toHaveLength(0)
  })

  it('該当なしの場合は空配列を返す', async () => {
    const { db } = makeMockListDb({ data: [itemA, itemB], error: null })
    const result = await listDistributorProducts(db, { keyword: '存在しないキーワード' })
    expect(result).toHaveLength(0)
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const { db } = makeMockListDb({ data: null, error: { message: 'DB error: table distributor_products' } })
    await expect(listDistributorProducts(db)).rejects.toThrow()
  })
})
