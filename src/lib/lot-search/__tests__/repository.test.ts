import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { searchLotItems, LOT_SEARCH_LIMIT } from '@/lib/lot-search/repository'
import { buildIlikeValueUnquoted } from '@/lib/search/like-pattern'

type QueryResult = { data: unknown; error: unknown }

// WHY(any を使わない): 実物の型（PostgrestFilterBuilder）はジェネリクスが深くモックでは再現できないが、
//      このテストが使うのは「6 つのメソッドが自分自身を返すこと」と「await できること」だけ。
//      その形だけを型にすれば足りる。最初は戻り値を any にして lint の無効化コメントを足していたが、
//      逃がし口の上限（scripts/check-exemptions.test.sh）を 1 件超えて CI が落ちた。上限を上げずに逃がし口を消した。
//      （この検査はコメントの中の文字列も数えるので、ここに無効化コメントの綴りそのものを書かないこと）
type ChainMethod = ReturnType<typeof vi.fn<() => ChainableQuery>>
type ChainableQuery = {
  select: ChainMethod
  eq: ChainMethod
  not: ChainMethod
  ilike: ChainMethod
  order: ChainMethod
  limit: ChainMethod
  then: (resolve: (value: QueryResult) => unknown) => unknown
}

function makeChainableQuery(result: QueryResult): ChainableQuery {
  const builder: ChainableQuery = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    not: vi.fn(() => builder),
    ilike: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    then: (resolve) => resolve(result),
  }
  return builder
}

type TableResults = Record<string, QueryResult>

function makeMockDb(tableResults: TableResults): {
  db: SupabaseClient
  queries: Record<string, ReturnType<typeof makeChainableQuery>>
} {
  const queries: Record<string, ReturnType<typeof makeChainableQuery>> = {}
  const from = vi.fn((table: string) => {
    const q = makeChainableQuery(tableResults[table] ?? { data: [], error: null })
    queries[table] = q
    return q
  })
  const db = { from } as unknown as SupabaseClient
  return { db, queries }
}

function emptyResults(): TableResults {
  return {
    case_order_items: { data: [], error: null },
    loan_return_items: { data: [], error: null },
  }
}

describe('searchLotItems（issue #803 Set A: P-013/P-015 明細の施設境界に準ずる横断検索）', () => {
  it('case_order_items と loan_return_items の両方を occurredAt 降順でマージして返す', async () => {
    const { db } = makeMockDb({
      case_order_items: {
        data: [
          {
            id: 'coi-1', case_order_id: 'co-1', jan: '111', lot: 'LOT-A', quantity: 2,
            case_orders: { facility_id: 'f-1', case_datetime: '2026-09-01T00:00:00Z' },
          },
        ],
        error: null,
      },
      loan_return_items: {
        data: [
          {
            id: 'lri-1', loan_return_id: 'lr-1', jan: '222', lot: 'LOT-A', quantity: 1,
            loan_returns: { facility_id: 'f-1', return_datetime: '2026-09-05T00:00:00Z' },
          },
        ],
        error: null,
      },
    })

    const result = await searchLotItems(db, 'f-1', 'LOT-A')

    expect(result.truncated).toBe(false)
    expect(result.items.map(i => i.itemId)).toEqual(['lri-1', 'coi-1'])
    expect(result.items[0]).toEqual({
      kind: 'loan_return',
      itemId: 'lri-1',
      parentId: 'lr-1',
      lot: 'LOT-A',
      jan: '222',
      quantity: 1,
      occurredAt: '2026-09-05T00:00:00Z',
    })
  })

  it('親テーブルを !inner 結合し、facility_id で明示的に絞り込む（RLS だけに頼らない。admin のクライアントでも越境しない）', async () => {
    const { db, queries } = makeMockDb(emptyResults())

    await searchLotItems(db, 'f-1', 'ABC')

    expect(queries.case_order_items.select).toHaveBeenCalledWith(
      expect.stringContaining('case_orders!inner(facility_id, case_datetime)')
    )
    expect(queries.case_order_items.eq).toHaveBeenCalledWith('case_orders.facility_id', 'f-1')
    expect(queries.loan_return_items.select).toHaveBeenCalledWith(
      expect.stringContaining('loan_returns!inner(facility_id, return_datetime)')
    )
    expect(queries.loan_return_items.eq).toHaveBeenCalledWith('loan_returns.facility_id', 'f-1')
  })

  // WHY(レビュー指摘の修正): 各テーブルの .order() は最終マージの並び替え基準（occurredAt）と
  //      同じ列で並べる必要がある。created_at など別の列で並べると「各テーブル単体で LIMIT+1
  //      件取れば、マージ後の上位 LIMIT+1 件を取りこぼさない」という truncated 判定の前提が
  //      崩れる（テーブル内の並び順と最終的な並び順が食い違うと、本来上位に入るはずの行が
  //      LIMIT+1 件の外に切り落とされうる）。
  it('各テーブルの order は occurredAt と同じ列（case_datetime / return_datetime）で並べる', async () => {
    const { db, queries } = makeMockDb(emptyResults())

    await searchLotItems(db, 'f-1', 'ABC')

    expect(queries.case_order_items.order).toHaveBeenCalledWith(
      'case_datetime',
      expect.objectContaining({ referencedTable: 'case_orders', ascending: false })
    )
    expect(queries.loan_return_items.order).toHaveBeenCalledWith(
      'return_datetime',
      expect.objectContaining({ referencedTable: 'loan_returns', ascending: false })
    )
  })

  it('lot IS NOT NULL を明示する（NULL LIKE は UNKNOWN で黙って外れるため、意図をコードでも固定する）', async () => {
    const { db, queries } = makeMockDb(emptyResults())

    await searchLotItems(db, 'f-1', 'ABC')

    expect(queries.case_order_items.not).toHaveBeenCalledWith('lot', 'is', null)
    expect(queries.loan_return_items.not).toHaveBeenCalledWith('lot', 'is', null)
  })

  it('検索語は buildIlikeValueUnquoted でエスケープしてから ilike に渡す（%・_・"・,・( を含む検索語）', async () => {
    const { db, queries } = makeMockDb(emptyResults())
    const tricky = '%_A",(B'

    await searchLotItems(db, 'f-1', tricky)

    const expected = buildIlikeValueUnquoted(tricky)
    expect(queries.case_order_items.ilike).toHaveBeenCalledWith('lot', expected)
    expect(queries.loan_return_items.ilike).toHaveBeenCalledWith('lot', expected)
    // ワイルドカードとして働かない = エスケープ後の値は元の '%' そのままではない（% 自体はエスケープ済み）
    expect(expected).not.toBe(`%${tricky}%`)
  })

  it('戻り値のキーは患者情報を含まない集合と完全一致する（患者の列が紛れ込んだら落ちる）', async () => {
    const { db } = makeMockDb({
      case_order_items: {
        data: [
          {
            id: 'coi-1', case_order_id: 'co-1', jan: '111', lot: 'LOT-A', quantity: 2,
            case_orders: { facility_id: 'f-1', case_datetime: '2026-09-01T00:00:00Z' },
          },
        ],
        error: null,
      },
      loan_return_items: { data: [], error: null },
    })

    const result = await searchLotItems(db, 'f-1', 'LOT-A')

    expect(Object.keys(result.items[0]).sort()).toEqual(
      ['kind', 'itemId', 'parentId', 'lot', 'jan', 'quantity', 'occurredAt'].sort()
    )
  })

  it('上限ちょうど（500件）では truncated = false', async () => {
    const rows = Array.from({ length: LOT_SEARCH_LIMIT }, (_, i) => ({
      id: `coi-${i}`, case_order_id: `co-${i}`, jan: '111', lot: 'LOT-A', quantity: 1,
      case_orders: { facility_id: 'f-1', case_datetime: new Date(2026, 0, 1, 0, 0, i).toISOString() },
    }))
    const { db } = makeMockDb({
      case_order_items: { data: rows, error: null },
      loan_return_items: { data: [], error: null },
    })

    const result = await searchLotItems(db, 'f-1', 'LOT-A')

    expect(result.items).toHaveLength(LOT_SEARCH_LIMIT)
    expect(result.truncated).toBe(false)
  })

  it('上限+1件では truncated = true になり、LIMIT件に切られる', async () => {
    const rows = Array.from({ length: LOT_SEARCH_LIMIT + 1 }, (_, i) => ({
      id: `coi-${i}`, case_order_id: `co-${i}`, jan: '111', lot: 'LOT-A', quantity: 1,
      case_orders: { facility_id: 'f-1', case_datetime: new Date(2026, 0, 1, 0, 0, i).toISOString() },
    }))
    const { db } = makeMockDb({
      case_order_items: { data: rows, error: null },
      loan_return_items: { data: [], error: null },
    })

    const result = await searchLotItems(db, 'f-1', 'LOT-A')

    expect(result.items).toHaveLength(LOT_SEARCH_LIMIT)
    expect(result.truncated).toBe(true)
  })

  it('DBエラー時は例外を投げる', async () => {
    const { db } = makeMockDb({
      case_order_items: { data: null, error: { message: 'boom' } },
      loan_return_items: { data: [], error: null },
    })

    await expect(searchLotItems(db, 'f-1', 'LOT-A')).rejects.toThrow('boom')
  })
})
