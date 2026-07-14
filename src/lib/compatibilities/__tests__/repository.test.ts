import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  listCompatibilities,
  createCompatibility,
  deleteCompatibility,
  listProductsInCategory,
  categoryExists,
  mapCompatibility,
  DUPLICATE_COMPATIBILITY_ERROR,
  CATEGORY_NOT_FOUND_ERROR,
} from '@/lib/compatibilities/repository'

// WHY: 本物のPostgRESTは.or()に渡した`path.column.ilike.pattern`形式の条件式で
// 埋め込みリソース(product1/product2)まで含めてDB側にフィルタをかける。
// 単体テストではSupabaseに接続しないため、渡された条件式を簡易パーサで解釈し、
// mockのdataに対して同じ絞り込みロジックを模倣適用することで、
// 「実装がJSで全件フィルタしているか／DBクエリ構築で完結しているか」を区別できるようにする。
function getNestedField(row: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = row
  for (const key of path) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function matchesOrExpr(row: Record<string, unknown>, orExpr: string): boolean {
  const conditions = orExpr.split(',')
  return conditions.some((condition) => {
    const parts = condition.split('.')
    const pattern = parts.pop() as string
    const op = parts.pop() as string
    if (op !== 'ilike') return false
    const value = getNestedField(row, parts)
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

const rowA = {
  id: 'c-1',
  category_id: 'cat-1',
  product_id_1: 'p-1',
  product_id_2: 'p-2',
  note: '互換です',
  created_at: '2026-07-14T00:00:00Z',
  updated_at: '2026-07-14T00:00:00Z',
  category: { name: '縫合糸' },
  product1: { jan: '111', name: '製品A', maker: 'メーカーA' },
  product2: { jan: '222', name: '製品B', maker: 'メーカーB' },
}

const rowB = {
  id: 'c-2',
  category_id: 'cat-2',
  product_id_1: 'p-3',
  product_id_2: 'p-4',
  note: null,
  created_at: '2026-07-13T00:00:00Z',
  updated_at: '2026-07-13T00:00:00Z',
  category: { name: '包帯' },
  product1: { jan: '333', name: '製品C', maker: null },
  product2: { jan: '444', name: '製品D', maker: 'メーカーD' },
}

describe('mapCompatibility', () => {
  it('JOIN済みの行をProductCompatibilityにマッピングする', () => {
    const result = mapCompatibility(rowA)
    expect(result).toEqual({
      id: 'c-1',
      categoryId: 'cat-1',
      categoryName: '縫合糸',
      productId1: 'p-1',
      product1: { jan: '111', name: '製品A', maker: 'メーカーA' },
      productId2: 'p-2',
      product2: { jan: '222', name: '製品B', maker: 'メーカーB' },
      note: '互換です',
      createdAt: '2026-07-14T00:00:00Z',
      updatedAt: '2026-07-14T00:00:00Z',
    })
  })

  it('noteがnullの場合はnullのまま返す', () => {
    const result = mapCompatibility(rowB)
    expect(result.note).toBeNull()
  })

  it('埋め込みリソースが配列で返る場合も先頭要素を使う', () => {
    const result = mapCompatibility({
      ...rowA,
      category: [{ name: '縫合糸' }],
      product1: [{ jan: '111', name: '製品A', maker: 'メーカーA' }],
    })
    expect(result.categoryName).toBe('縫合糸')
    expect(result.product1.jan).toBe('111')
  })
})

describe('listCompatibilities', () => {
  it('categoryId未指定時は全件をcreated_at降順で返す', async () => {
    const { db } = makeMockListDb({ data: [rowA, rowB], error: null })
    const result = await listCompatibilities(db)
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('c-1')
  })

  it('categoryId指定時はeqで絞り込む', async () => {
    const { db, query } = makeMockListDb({ data: [rowA], error: null })
    await listCompatibilities(db, { categoryId: 'cat-1' })
    expect(query.eq).toHaveBeenCalledWith('category_id', 'cat-1')
  })

  it('keywordがproduct1のnameに一致する行のみ返す', async () => {
    const { db } = makeMockListDb({ data: [rowA, rowB], error: null })
    const result = await listCompatibilities(db, { keyword: '製品A' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('c-1')
  })

  it('keywordがproduct2のjanに一致する行のみ返す', async () => {
    const { db } = makeMockListDb({ data: [rowA, rowB], error: null })
    const result = await listCompatibilities(db, { keyword: '444' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('c-2')
  })

  it('keywordがmakerに一致する行のみ返す（大文字小文字を無視）', async () => {
    const { db } = makeMockListDb({ data: [rowA, rowB], error: null })
    const result = await listCompatibilities(db, { keyword: 'メーカーd' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('c-2')
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const { db } = makeMockListDb({ data: null, error: { message: 'DB error' } })
    await expect(listCompatibilities(db)).rejects.toThrow('DB error')
  })
})

describe('createCompatibility', () => {
  it('productId1 > productId2 の場合は正規化して挿入する', async () => {
    const insertFn = vi.fn(() => ({
      select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: rowA, error: null }) })),
    }))
    const db = { from: vi.fn(() => ({ insert: insertFn })) } as unknown as SupabaseClient

    await createCompatibility(db, {
      categoryId: 'cat-1',
      productId1: 'p-2',
      productId2: 'p-1',
      note: null,
    })

    expect(insertFn).toHaveBeenCalledWith(
      expect.objectContaining({ product_id_1: 'p-1', product_id_2: 'p-2' })
    )
  })

  it('23505エラー時にDUPLICATE_COMPATIBILITY_ERRORを投げる', async () => {
    const db = {
      from: vi.fn(() => ({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: null, error: { code: '23505', message: 'dup' } }) })),
        })),
      })),
    } as unknown as SupabaseClient

    await expect(
      createCompatibility(db, { categoryId: 'cat-1', productId1: 'p-1', productId2: 'p-2', note: null })
    ).rejects.toThrow(DUPLICATE_COMPATIBILITY_ERROR)
  })

  it('23503エラー時にCATEGORY_NOT_FOUND_ERRORを投げる', async () => {
    const db = {
      from: vi.fn(() => ({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: null, error: { code: '23503', message: 'fk' } }) })),
        })),
      })),
    } as unknown as SupabaseClient

    await expect(
      createCompatibility(db, { categoryId: 'no-such', productId1: 'p-1', productId2: 'p-2', note: null })
    ).rejects.toThrow(CATEGORY_NOT_FOUND_ERROR)
  })
})

describe('deleteCompatibility', () => {
  it('削除できた場合はtrueを返す', async () => {
    const db = {
      from: vi.fn(() => ({
        delete: vi.fn(() => ({ eq: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: [{ id: 'c-1' }], error: null }) })) })),
      })),
    } as unknown as SupabaseClient
    const result = await deleteCompatibility(db, 'c-1')
    expect(result).toBe(true)
  })

  it('対象が存在しない場合はfalseを返す（例外は投げない）', async () => {
    const db = {
      from: vi.fn(() => ({
        delete: vi.fn(() => ({ eq: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: [], error: null }) })) })),
      })),
    } as unknown as SupabaseClient
    const result = await deleteCompatibility(db, 'no-such')
    expect(result).toBe(false)
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const db = {
      from: vi.fn(() => ({
        delete: vi.fn(() => ({ eq: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }) })) })),
      })),
    } as unknown as SupabaseClient
    await expect(deleteCompatibility(db, 'c-1')).rejects.toThrow('DB error')
  })
})

describe('listProductsInCategory', () => {
  it('distributor_products経由でcategory_idに紐づく製品を重複排除して返す', async () => {
    const rows = [
      { product: { id: 'p-1', jan: '111', ref: 'r1', name: '製品A', maker: 'メーカーA', created_at: 't', updated_at: 't' } },
      { product: { id: 'p-1', jan: '111', ref: 'r1', name: '製品A', maker: 'メーカーA', created_at: 't', updated_at: 't' } },
      { product: { id: 'p-2', jan: '222', ref: 'r2', name: '製品B', maker: null, created_at: 't', updated_at: 't' } },
    ]
    const eqFn = vi.fn().mockResolvedValue({ data: rows, error: null })
    const db = { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: eqFn })) })) } as unknown as SupabaseClient

    const result = await listProductsInCategory(db, 'cat-1')
    expect(result).toHaveLength(2)
    expect(result.map(p => p.id)).toEqual(['p-1', 'p-2'])
    expect(eqFn).toHaveBeenCalledWith('category_id', 'cat-1')
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const eqFn = vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } })
    const db = { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: eqFn })) })) } as unknown as SupabaseClient
    await expect(listProductsInCategory(db, 'cat-1')).rejects.toThrow('DB error')
  })
})

describe('categoryExists', () => {
  it('カテゴリが存在する場合はtrueを返す', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'cat-1' }, error: null })
    const db = { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })) })) } as unknown as SupabaseClient
    await expect(categoryExists(db, 'cat-1')).resolves.toBe(true)
  })

  it('カテゴリが存在しない場合はfalseを返す', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const db = { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })) })) } as unknown as SupabaseClient
    await expect(categoryExists(db, 'no-such')).resolves.toBe(false)
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } })
    const db = { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })) })) } as unknown as SupabaseClient
    await expect(categoryExists(db, 'cat-1')).rejects.toThrow('DB error')
  })
})
