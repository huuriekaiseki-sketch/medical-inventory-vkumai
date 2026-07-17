import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLoanOrder, listLoanOrders, mapItem } from '@/lib/loan-orders/repository'

function makeMockRpcDb(rpcResult: unknown): SupabaseClient {
  return { rpc: vi.fn().mockResolvedValue(rpcResult) } as unknown as SupabaseClient
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeChainableQuery(result: { data: unknown; error: unknown }): any {
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lte: vi.fn(() => builder),
    range: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => resolve(result),
  }
  return builder
}

function makeMockListDb(result: { data: unknown; error: unknown }): { db: SupabaseClient; query: ReturnType<typeof makeChainableQuery> } {
  const query = makeChainableQuery(result)
  const db = { from: vi.fn(() => query) } as unknown as SupabaseClient
  return { db, query }
}

describe('createLoanOrder', () => {
  const mockRpcResult = {
    id: 'lo-1', facility_id: 'f-1', procedure_name: 'TAVI', maker: 'メドトロニック',
    status: 'draft', created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
    items: [
      { id: 'i-1', loan_order_id: 'lo-1', jan: '490001', name: 'カテーテルA', quantity: 1, created_at: '2026-06-24T00:00:00Z' },
    ],
  }

  it('RPC を呼んで LoanOrder を返す', async () => {
    const db = makeMockRpcDb({ data: mockRpcResult, error: null })
    const result = await createLoanOrder(db, 'f-1', {
      procedureName: 'TAVI',
      maker: 'メドトロニック',
      items: [{ jan: '490001', name: 'カテーテルA', quantity: 1 }],
    })
    expect(result.id).toBe('lo-1')
    expect(result.procedureName).toBe('TAVI')
    expect(result.maker).toBe('メドトロニック')
    expect(result.items[0].name).toBe('カテーテルA')
  })

  it('create_loan_order_atomic を正しい引数で呼ぶ', async () => {
    const db = makeMockRpcDb({ data: mockRpcResult, error: null })
    const rpc = db.rpc as ReturnType<typeof vi.fn>

    await createLoanOrder(db, 'f-1', {
      procedureName: 'TAVI',
      maker: 'メドトロニック',
      items: [{ jan: '490001', name: 'カテーテルA', quantity: 1 }],
    })

    expect(rpc).toHaveBeenCalledWith('create_loan_order_atomic', expect.objectContaining({
      p_facility_id: 'f-1',
      p_procedure_name: 'TAVI',
      p_maker: 'メドトロニック',
    }))
    const args = rpc.mock.calls[0][1] as Record<string, unknown>
    // p_items はJSONB引数のため配列のまま渡す（JSON.stringifyしない。issue #287）
    expect(args.p_items).toEqual([
      { jan: '490001', name: 'カテーテルA', quantity: 1 },
    ])
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const db = makeMockRpcDb({ data: null, error: { message: 'DB error' } })

    await expect(
      createLoanOrder(db, 'f-1', { procedureName: 'TAVI', maker: 'M', items: [] })
    ).rejects.toThrow('DB error')
  })

  it('DBのstatusが想定外の値の場合はdraftにフォールバックする', async () => {
    const db = makeMockRpcDb({ data: { ...mockRpcResult, status: 'invalid' }, error: null })
    const result = await createLoanOrder(db, 'f-1', { procedureName: 'TAVI', maker: 'M', items: [] })
    expect(result.status).toBe('draft')
  })
})

describe('listLoanOrders', () => {
  const rows = [
    {
      id: 'lo-1', facility_id: 'f-1', procedure_name: 'TAVI', maker: 'メドトロニック',
      status: 'submitted', created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
      loan_order_items: [{ id: 'i-1', loan_order_id: 'lo-1', jan: '490001', name: 'カテーテルA', quantity: 1, created_at: '2026-06-24T00:00:00Z' }],
    },
    {
      id: 'lo-2', facility_id: 'f-1', procedure_name: 'PCI', maker: 'アボット',
      status: 'draft', created_at: '2026-06-25T00:00:00Z', updated_at: '2026-06-25T00:00:00Z',
      loan_order_items: [{ id: 'i-2', loan_order_id: 'lo-2', jan: '490002', name: 'バルーンB', quantity: 2, created_at: '2026-06-25T00:00:00Z' }],
    },
  ]

  it('デフォルト引数（filterなし）で一覧を返す', async () => {
    const { db } = makeMockListDb({ data: rows, error: null })
    const result = await listLoanOrders(db, 'f-1')
    expect(result).toHaveLength(2)
  })

  it('filter未指定時はrangeで従来通りページングする', async () => {
    const { db, query } = makeMockListDb({ data: rows, error: null })
    await listLoanOrders(db, 'f-1', 10, 5)
    expect(query.range).toHaveBeenCalledWith(5, 14)
  })

  it('keywordがprocedure_nameに一致する行のみ返す', async () => {
    const { db } = makeMockListDb({ data: rows, error: null })
    const result = await listLoanOrders(db, 'f-1', 50, 0, { keyword: 'TAVI' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('lo-1')
  })

  it('keywordがmakerに一致する行も返す', async () => {
    const { db } = makeMockListDb({ data: rows, error: null })
    const result = await listLoanOrders(db, 'f-1', 50, 0, { keyword: 'アボット' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('lo-2')
  })

  it('keywordがitems[].nameに一致する行も返す', async () => {
    const { db } = makeMockListDb({ data: rows, error: null })
    const result = await listLoanOrders(db, 'f-1', 50, 0, { keyword: 'バルーンB' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('lo-2')
  })

  it('dateFrom/dateToはJSTの日境界でgte/lteに変換される', async () => {
    const { db, query } = makeMockListDb({ data: rows, error: null })
    await listLoanOrders(db, 'f-1', 50, 0, { dateFrom: '2026-06-24', dateTo: '2026-06-25' })
    expect(query.gte).toHaveBeenCalledWith('created_at', '2026-06-24T00:00:00+09:00')
    expect(query.lte).toHaveBeenCalledWith('created_at', '2026-06-25T23:59:59+09:00')
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const { db } = makeMockListDb({ data: null, error: { message: 'DB error' } })
    await expect(listLoanOrders(db, 'f-1')).rejects.toThrow('DB error')
  })
})

// issue #459: unit_priceカラムがアプリ層で無視されていた回帰テスト
describe('mapItem', () => {
  it('unit_priceが数値の場合、unitPriceに数値としてマッピングされる', () => {
    const item = mapItem({
      id: 'i-1', loan_order_id: 'lo-1', jan: '4901234567890',
      name: 'テスト器具', quantity: 1, unit_price: 30000, created_at: '2026-06-24T00:00:00Z',
    })
    expect(item.unitPrice).toBe(30000)
  })

  it('unit_priceがnull(既存データ)の場合、unitPriceはnullになる', () => {
    const item = mapItem({
      id: 'i-1', loan_order_id: 'lo-1', jan: '4901234567890',
      name: 'テスト器具', quantity: 1, unit_price: null, created_at: '2026-06-24T00:00:00Z',
    })
    expect(item.unitPrice).toBeNull()
  })

  it('unit_priceが未定義の場合もエラーにならずnullになる', () => {
    const item = mapItem({
      id: 'i-1', loan_order_id: 'lo-1', jan: '4901234567890',
      name: 'テスト器具', quantity: 1, created_at: '2026-06-24T00:00:00Z',
    })
    expect(item.unitPrice).toBeNull()
  })
})
