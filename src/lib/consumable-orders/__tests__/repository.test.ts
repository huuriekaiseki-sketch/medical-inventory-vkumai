import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  CONSUMABLE_NOT_ORDERABLE_ERROR,
  createConsumableOrder,
  listConsumableOrders,
  mapItem,
} from '@/lib/consumable-orders/repository'
import { INVARIANT_VIOLATION_MESSAGE } from '@/lib/invariant-error'

function makeMockRpcDb(rpcResult: unknown): SupabaseClient {
  return { rpc: vi.fn().mockResolvedValue(rpcResult) } as unknown as SupabaseClient
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase のクエリビルダはメソッドチェーンで、実物の型（PostgrestFilterBuilder）はジェネリクスが深く、テスト用のモックでは再現できない。このモック関数の戻り値に限って any を使う
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

  // WHY(2026-09-09、I-035): 何が選べるかの判定は RPC が 1 か所で持っている。
  //      アプリの仕事は**エラーを利用者に読める一文へ写すこと**だけなので、ここで固定するのは写し方。
  //      写しを間違えると「一覧を開き直せば直る」ことが伝わらず、利用者は詰まったままになる。
  //      DB のエラーの形（23514 ＋ `is not orderable`）は
  //      統合テスト（consumable-order-items-boundary）が実 DB で同じ形を実測している。
  it('選べない消耗品（23514 ＋ is not orderable）を、やることが分かる一文に写す [I-035]', async () => {
    const db = makeMockRpcDb({
      data: null,
      error: { code: '23514', message: 'consumable 0d0 is not orderable in this facility (retired or belongs elsewhere)' },
    })
    await expect(
      createConsumableOrder(db, 'f-1', { items: [{ consumableId: 'c-1', quantity: 1 }] })
    ).rejects.toThrow(CONSUMABLE_NOT_ORDERABLE_ERROR)
  })

  it('同じ 23514 でも、別の業務ルール違反は汎用の一文のまま（写しすぎない） [I-035]', async () => {
    // WHY(C-023 の型): 合図（23514）が同じなので、文言まで見ないと層を取り違える。
    //      何でも「一覧を開き直してください」に写すと、まったく別の原因を誤って案内する
    const db = makeMockRpcDb({
      data: null,
      error: { code: '23514', message: 'quantity must be positive' },
    })
    await expect(
      createConsumableOrder(db, 'f-1', { items: [{ consumableId: 'c-1', quantity: 0 }] })
    ).rejects.toThrow(INVARIANT_VIOLATION_MESSAGE)
  })

  it('文言が同じでもコードが違えば写さない（23514 であることも見る） [I-035]', async () => {
    const db = makeMockRpcDb({
      data: null,
      error: { code: '23503', message: 'is not orderable' },
    })
    await expect(
      createConsumableOrder(db, 'f-1', { items: [{ consumableId: 'c-1', quantity: 1 }] })
    ).rejects.not.toThrow(CONSUMABLE_NOT_ORDERABLE_ERROR)
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
    expect(query.lte).toHaveBeenCalledWith('created_at', '2026-06-25T23:59:59.999999+09:00')
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const { db } = makeMockListDb({ data: null, error: { message: 'DB error' } })
    await expect(listConsumableOrders(db, 'f-1')).rejects.toThrow('DB error')
  })
})

// issue #459: unit_priceカラムがアプリ層で無視されていた回帰テスト
describe('mapItem', () => {
  it('unit_priceが数値の場合、unitPriceに数値としてマッピングされる', () => {
    const item = mapItem({
      id: 'i-1', consumable_order_id: 'co-1', consumable_id: 'c-1',
      quantity: 3, unit_price: 500, created_at: '2026-06-24T00:00:00Z',
    })
    expect(item.unitPrice).toBe(500)
  })

  it('unit_priceがnull(既存データ)の場合、unitPriceはnullになる', () => {
    const item = mapItem({
      id: 'i-1', consumable_order_id: 'co-1', consumable_id: 'c-1',
      quantity: 3, unit_price: null, created_at: '2026-06-24T00:00:00Z',
    })
    expect(item.unitPrice).toBeNull()
  })

  it('unit_priceが未定義の場合もエラーにならずnullになる', () => {
    const item = mapItem({
      id: 'i-1', consumable_order_id: 'co-1', consumable_id: 'c-1',
      quantity: 3, created_at: '2026-06-24T00:00:00Z',
    })
    expect(item.unitPrice).toBeNull()
  })
})
