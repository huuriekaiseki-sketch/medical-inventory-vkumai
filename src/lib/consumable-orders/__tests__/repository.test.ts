import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createConsumableOrder, listConsumableOrders } from '@/lib/consumable-orders/repository'

function makeMockRpcDb(rpcResult: unknown): SupabaseClient {
  return { rpc: vi.fn().mockResolvedValue(rpcResult) } as unknown as SupabaseClient
}

// issue #20 SET-C: 複数ステップのSupabaseクエリ（.select().eq().gte()...）をチェーン可能な
// モックとして表現するヘルパー。各メソッドは同一builderを返し、awaitされた時点で
// resultをdata/errorとして解決する（実際のsupabase-jsのPostgrestFilterBuilderと同じ振る舞い）
type QueryResult = { data: unknown; error: unknown }
type ChainableBuilder = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<QueryResult>

function makeChainable(result: QueryResult): ChainableBuilder {
  const builder = {} as ChainableBuilder
  const methods = ['select', 'eq', 'gte', 'lte', 'ilike', 'in', 'order', 'range']
  for (const m of methods) {
    ;(builder as Record<string, unknown>)[m] = vi.fn(() => builder)
  }
  builder.then = ((resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)) as ChainableBuilder['then']
  return builder
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

// issue #20 SET-C: listConsumableOrders への dateFrom/dateTo/productSearch フィルタ拡張
describe('listConsumableOrders', () => {
  const mockRow = {
    id: 'coo-1', facility_id: 'f-1', status: 'draft',
    created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
    consumable_order_items: [],
  }

  it('facility_id で絞り込み、created_at 降順で limit/offset の範囲を取得する', async () => {
    const ordersBuilder = makeChainable({ data: [mockRow], error: null })
    const db = { from: vi.fn(() => ordersBuilder) } as unknown as SupabaseClient

    const result = await listConsumableOrders(db, 'f-1', 50, 0)

    expect(db.from).toHaveBeenCalledWith('consumable_orders')
    expect(ordersBuilder.eq).toHaveBeenCalledWith('facility_id', 'f-1')
    expect(ordersBuilder.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(ordersBuilder.order).toHaveBeenCalledWith('id', { ascending: true })
    expect(ordersBuilder.range).toHaveBeenCalledWith(0, 49)
    expect(result).toHaveLength(1)
  })

  // issue #20 型安全・データ層整合レビュー対応（important）: summaryLabel は
  // items[0]（代表1品目）を使うが、埋め込みクエリ(consumable_order_items(*))に明示的な
  // ORDER BY が無いと代表製品名の選出が理論上非決定的になる。作成順（created_at昇順・
  // id昇順を第2キー）を明示することで「最初に登録した明細」を安定して代表として選出する
  it('consumable_order_items（埋め込み）にcreated_at昇順・id昇順の明示的なORDER BYを指定する', async () => {
    const ordersBuilder = makeChainable({ data: [mockRow], error: null })
    const db = { from: vi.fn(() => ordersBuilder) } as unknown as SupabaseClient

    await listConsumableOrders(db, 'f-1', 50, 0)

    expect(ordersBuilder.order).toHaveBeenCalledWith('created_at', {
      ascending: true,
      referencedTable: 'consumable_order_items',
    })
    expect(ordersBuilder.order).toHaveBeenCalledWith('id', {
      ascending: true,
      referencedTable: 'consumable_order_items',
    })
  })

  // issue #20 型安全・データ層整合レビュー対応（important）: SPEC.md Part2 SET-C テスト観点
  // 「limit上限: 最大100（100超は400エラー）、負数は400エラー」の未実装・未テストを解消
  it('limitが100を超える場合はエラーを投げる', async () => {
    const db = { from: vi.fn() } as unknown as SupabaseClient
    await expect(listConsumableOrders(db, 'f-1', 101, 0)).rejects.toThrow('limit は 1〜100 の整数で指定してください')
  })

  it('offsetが負数の場合はエラーを投げる', async () => {
    const db = { from: vi.fn() } as unknown as SupabaseClient
    await expect(listConsumableOrders(db, 'f-1', 50, -1)).rejects.toThrow('offset は0以上の整数で指定してください')
  })

  it('dateFrom/dateTo を指定すると created_at に gte/lte を適用する', async () => {
    const ordersBuilder = makeChainable({ data: [mockRow], error: null })
    const db = { from: vi.fn(() => ordersBuilder) } as unknown as SupabaseClient

    await listConsumableOrders(db, 'f-1', 50, 0, { dateFrom: '2026-06-01T00:00:00Z', dateTo: '2026-06-30T23:59:59Z' })

    expect(ordersBuilder.gte).toHaveBeenCalledWith('created_at', '2026-06-01T00:00:00Z')
    expect(ordersBuilder.lte).toHaveBeenCalledWith('created_at', '2026-06-30T23:59:59Z')
  })

  it('productSearch が空文字/未指定の場合は consumables / consumable_order_items を問い合わせない', async () => {
    const ordersBuilder = makeChainable({ data: [mockRow], error: null })
    const from = vi.fn((table: string) => {
      if (table === 'consumable_orders') return ordersBuilder
      throw new Error(`unexpected table: ${table}`)
    })
    const db = { from } as unknown as SupabaseClient

    await listConsumableOrders(db, 'f-1', 50, 0, { productSearch: '' })

    expect(from).toHaveBeenCalledTimes(1)
  })

  it('productSearch を指定すると consumables→consumable_order_items 経由で対象IDを絞り込む', async () => {
    const consumablesBuilder = makeChainable({ data: [{ id: 'c-1' }, { id: 'c-2' }], error: null })
    const itemsBuilder = makeChainable({ data: [{ consumable_order_id: 'coo-1' }], error: null })
    const ordersBuilder = makeChainable({ data: [mockRow], error: null })
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'consumables') return consumablesBuilder
        if (table === 'consumable_order_items') return itemsBuilder
        if (table === 'consumable_orders') return ordersBuilder
        throw new Error(`unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    const result = await listConsumableOrders(db, 'f-1', 50, 0, { productSearch: 'ガーゼ' })

    expect(consumablesBuilder.select).toHaveBeenCalledWith('id')
    expect(consumablesBuilder.eq).toHaveBeenCalledWith('facility_id', 'f-1')
    expect(consumablesBuilder.ilike).toHaveBeenCalledWith('name', '%ガーゼ%')
    expect(itemsBuilder.in).toHaveBeenCalledWith('consumable_id', ['c-1', 'c-2'])
    expect(ordersBuilder.in).toHaveBeenCalledWith('id', ['coo-1'])
    expect(result).toHaveLength(1)
  })

  it('productSearch にヒットする消耗品が無い場合は空配列を返す', async () => {
    const consumablesBuilder = makeChainable({ data: [], error: null })
    const from = vi.fn((table: string) => {
      if (table === 'consumables') return consumablesBuilder
      throw new Error(`unexpected table: ${table}`)
    })
    const db = { from } as unknown as SupabaseClient

    const result = await listConsumableOrders(db, 'f-1', 50, 0, { productSearch: 'ヒットしない' })

    expect(result).toEqual([])
    expect(from).toHaveBeenCalledTimes(1)
  })

  it('Supabaseエラー時に例外を投げる（メインクエリ）', async () => {
    const ordersBuilder = makeChainable({ data: null, error: { message: 'DB error' } })
    const db = { from: vi.fn(() => ordersBuilder) } as unknown as SupabaseClient

    await expect(listConsumableOrders(db, 'f-1', 50, 0)).rejects.toThrow('DB error')
  })
})
