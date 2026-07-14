import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createConsumableOrder, listConsumableOrders } from '@/lib/consumable-orders/repository'

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

function makeMockListDb(result: { data: unknown; error: unknown }): { db: SupabaseClient; query: ReturnType<typeof makeChainableQuery>; from: ReturnType<typeof vi.fn> } {
  const query = makeChainableQuery(result)
  const from = vi.fn(() => query)
  const db = { from } as unknown as SupabaseClient
  return { db, query, from }
}

describe('createConsumableOrder', () => {
  const mockRpcResult = {
    id: 'coo-1', facility_id: 'f-1', status: 'draft',
    created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
    items: [
      { id: 'i-1', consumable_order_id: 'coo-1', consumable_id: 'c-1', quantity: 3, created_at: '2026-06-24T00:00:00Z' },
    ],
  }

  it('RPC を呼んで ConsumableOrder を返す', async () => {
    const db = makeMockRpcDb({ data: mockRpcResult, error: null })
    const result = await createConsumableOrder(db, 'f-1', {
      items: [{ consumableId: 'c-1', quantity: 3 }],
    })
    expect(result.id).toBe('coo-1')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].consumableId).toBe('c-1')
    expect(result.items[0].quantity).toBe(3)
  })

  it('create_consumable_order_atomic を正しい引数で呼ぶ', async () => {
    const db = makeMockRpcDb({ data: mockRpcResult, error: null })
    const rpc = db.rpc as ReturnType<typeof vi.fn>

    await createConsumableOrder(db, 'f-1', { items: [{ consumableId: 'c-1', quantity: 3 }] })

    expect(rpc).toHaveBeenCalledWith('create_consumable_order_atomic', expect.objectContaining({
      p_facility_id: 'f-1',
    }))
    const args = rpc.mock.calls[0][1] as Record<string, unknown>
    // p_items はJSONB引数のため配列のまま渡す（JSON.stringifyしない。issue #287）
    expect(args.p_items).toEqual([
      { consumable_id: 'c-1', quantity: 3 },
    ])
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const db = makeMockRpcDb({ data: null, error: { message: 'DB error' } })

    await expect(
      createConsumableOrder(db, 'f-1', { items: [] })
    ).rejects.toThrow('DB error')
  })

  it('DBのstatusが想定外の値の場合はdraftにフォールバックする', async () => {
    const db = makeMockRpcDb({ data: { ...mockRpcResult, status: 'invalid' }, error: null })
    const result = await createConsumableOrder(db, 'f-1', { items: [] })
    expect(result.status).toBe('draft')
  })
})

describe('listConsumableOrders', () => {
  const rows = [
    {
      id: 'coo-1', facility_id: 'f-1', status: 'submitted',
      created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
      consumable_order_items: [
        { id: 'i-1', consumable_order_id: 'coo-1', consumable_id: 'c-1', quantity: 2, created_at: '2026-06-24T00:00:00Z', consumables: { name: 'シリンジ', jan: '111' } },
      ],
    },
    {
      id: 'coo-2', facility_id: 'f-1', status: 'draft',
      created_at: '2026-06-25T00:00:00Z', updated_at: '2026-06-25T00:00:00Z',
      consumable_order_items: [
        { id: 'i-2', consumable_order_id: 'coo-2', consumable_id: 'c-2', quantity: 1, created_at: '2026-06-25T00:00:00Z', consumables: { name: 'ガーゼ', jan: '222' } },
      ],
    },
  ]

  it('デフォルト引数（filterなし）で一覧を返す', async () => {
    const { db } = makeMockListDb({ data: rows, error: null })
    const result = await listConsumableOrders(db, 'f-1')
    expect(result).toHaveLength(2)
  })

  it('filter未指定時はrangeで従来通りページングする', async () => {
    const { db, query } = makeMockListDb({ data: rows, error: null })
    await listConsumableOrders(db, 'f-1', 10, 5)
    expect(query.range).toHaveBeenCalledWith(5, 14)
  })

  it('keyword指定時はconsumablesをネストJOINしたクエリを使う', async () => {
    const { db, query } = makeMockListDb({ data: rows, error: null })
    await listConsumableOrders(db, 'f-1', 50, 0, { keyword: 'シリンジ' })
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining('consumables(name, jan)'))
  })

  it('keywordが消耗品名(consumables.name)に一致する行のみ返す', async () => {
    const { db } = makeMockListDb({ data: rows, error: null })
    const result = await listConsumableOrders(db, 'f-1', 50, 0, { keyword: 'シリンジ' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('coo-1')
  })

  it('keywordが消耗品のjanに一致する行も返す', async () => {
    const { db } = makeMockListDb({ data: rows, error: null })
    const result = await listConsumableOrders(db, 'f-1', 50, 0, { keyword: '222' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('coo-2')
  })

  it('dateFrom/dateToはJSTの日境界でgte/lteに変換される', async () => {
    const { db, query } = makeMockListDb({ data: rows, error: null })
    await listConsumableOrders(db, 'f-1', 50, 0, { dateFrom: '2026-06-24', dateTo: '2026-06-25' })
    expect(query.gte).toHaveBeenCalledWith('created_at', '2026-06-24T00:00:00+09:00')
    expect(query.lte).toHaveBeenCalledWith('created_at', '2026-06-25T23:59:59+09:00')
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const { db } = makeMockListDb({ data: null, error: { message: 'DB error' } })
    await expect(listConsumableOrders(db, 'f-1')).rejects.toThrow('DB error')
  })
})
