import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createCaseOrder, listCaseOrders } from '@/lib/case-orders/repository'

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

describe('createCaseOrder', () => {
  // RPC は case_orders 行 + items 配列をネストした JSONB を返す
  const mockRpcResult = {
    id: 'co-1',
    facility_id: 'f-1',
    case_datetime: '2026-06-24T10:00:00Z',
    procedure_name: 'TAVI',
    patient_id: 'P001',
    patient_initials: 'T.S.',
    gender: 'male',
    doctor_name: '田中医師',
    status: 'draft',
    created_at: '2026-06-24T00:00:00Z',
    updated_at: '2026-06-24T00:00:00Z',
    items: [
      { id: 'i-1', case_order_id: 'co-1', jan: '4901234567890', lot: 'L001', ubd: '2027-01', quantity: 2, created_at: '2026-06-24T00:00:00Z' },
    ],
  }

  it('RPC を呼んで CaseOrder を返す', async () => {
    const db = makeMockRpcDb({ data: mockRpcResult, error: null })
    const result = await createCaseOrder(db, 'f-1', {
      caseDatetime: '2026-06-24T10:00:00Z',
      procedureName: 'TAVI',
      patientId: 'P001',
      patientInitials: 'T.S.',
      gender: 'male',
      doctorName: '田中医師',
      items: [{ jan: '4901234567890', lot: 'L001', ubd: '2027-01', quantity: 2 }],
    })

    expect(result.id).toBe('co-1')
    expect(result.procedureName).toBe('TAVI')
    expect(result.gender).toBe('male')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].jan).toBe('4901234567890')
    expect(result.items[0].quantity).toBe(2)
  })

  it('create_case_order_atomic を正しい引数で呼ぶ', async () => {
    const db = makeMockRpcDb({ data: mockRpcResult, error: null })
    const rpc = db.rpc as ReturnType<typeof vi.fn>

    await createCaseOrder(db, 'f-1', {
      caseDatetime: '2026-06-24T10:00:00Z',
      procedureName: 'TAVI',
      patientId: 'P001',
      patientInitials: 'T.S.',
      gender: 'male',
      doctorName: '田中医師',
      items: [{ jan: '4901234567890', lot: 'L001', ubd: '2027-01', quantity: 2 }],
    })

    expect(rpc).toHaveBeenCalledWith('create_case_order_atomic', expect.objectContaining({
      p_facility_id: 'f-1',
      p_procedure_name: 'TAVI',
    }))
    const args = rpc.mock.calls[0][1] as Record<string, unknown>
    // p_items はJSONB引数のため配列のまま渡す（JSON.stringifyしない。issue #287）
    expect(args.p_items).toEqual([
      { jan: '4901234567890', lot: 'L001', ubd: '2027-01', quantity: 2 },
    ])
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const db = makeMockRpcDb({ data: null, error: { message: 'DB error' } })

    await expect(
      createCaseOrder(db, 'f-1', {
        caseDatetime: '2026-06-24T10:00:00Z',
        procedureName: 'TAVI',
        patientId: 'P001',
        patientInitials: 'T.S.',
        gender: 'male',
        doctorName: '田中医師',
        items: [],
      })
    ).rejects.toThrow('DB error')
  })

  it('DBのgender/statusが想定外の値の場合はフォールバックする', async () => {
    const db = makeMockRpcDb({
      data: { ...mockRpcResult, gender: 'unknown', status: 'invalid' },
      error: null,
    })
    const result = await createCaseOrder(db, 'f-1', {
      caseDatetime: '2026-06-24T10:00:00Z',
      procedureName: 'TAVI',
      patientId: 'P001',
      patientInitials: 'T.S.',
      gender: 'male',
      doctorName: '田中医師',
      items: [],
    })
    expect(result.gender).toBe('other')
    expect(result.status).toBe('draft')
  })
})

// issue #20 SET-C: listCaseOrders への dateFrom/dateTo/productSearch フィルタ拡張
describe('listCaseOrders', () => {
  const mockRow = {
    id: 'co-1',
    facility_id: 'f-1',
    case_datetime: '2026-06-24T10:00:00Z',
    procedure_name: 'TAVI',
    patient_id: 'P001',
    patient_initials: 'T.S.',
    gender: 'male',
    doctor_name: '田中医師',
    status: 'draft',
    created_at: '2026-06-24T00:00:00Z',
    updated_at: '2026-06-24T00:00:00Z',
    case_order_items: [],
  }

  // issue #20 型安全・データ層整合レビュー対応（critical）: dateFrom/dateTo は case_datetime で
  // 絞り込むため、.order() も created_at ではなく case_datetime でなければ、施設ごとの
  // 該当件数が limit を超えた場合にDB側で誤ったキーで先に切り詰められるバグになる
  it('facility_id で絞り込み、case_datetime 降順・id昇順で limit/offset の範囲を取得する', async () => {
    const caseOrdersBuilder = makeChainable({ data: [mockRow], error: null })
    const db = { from: vi.fn(() => caseOrdersBuilder) } as unknown as SupabaseClient

    const result = await listCaseOrders(db, 'f-1', 50, 0)

    expect(db.from).toHaveBeenCalledWith('case_orders')
    expect(caseOrdersBuilder.eq).toHaveBeenCalledWith('facility_id', 'f-1')
    expect(caseOrdersBuilder.order).toHaveBeenCalledWith('case_datetime', { ascending: false })
    expect(caseOrdersBuilder.order).toHaveBeenCalledWith('id', { ascending: true })
    expect(caseOrdersBuilder.range).toHaveBeenCalledWith(0, 49)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('co-1')
  })

  // issue #20 型安全・データ層整合レビュー対応（important）: summaryLabel は
  // items[0]（代表1品目）を使うが、埋め込みクエリ(case_order_items(*))に明示的な
  // ORDER BY が無いと代表製品名の選出が理論上非決定的になる。作成順（created_at昇順・
  // id昇順を第2キー）を明示することで「最初に登録した明細」を安定して代表として選出する
  it('case_order_items（埋め込み）にcreated_at昇順・id昇順の明示的なORDER BYを指定する', async () => {
    const caseOrdersBuilder = makeChainable({ data: [mockRow], error: null })
    const db = { from: vi.fn(() => caseOrdersBuilder) } as unknown as SupabaseClient

    await listCaseOrders(db, 'f-1', 50, 0)

    expect(caseOrdersBuilder.order).toHaveBeenCalledWith('created_at', {
      ascending: true,
      referencedTable: 'case_order_items',
    })
    expect(caseOrdersBuilder.order).toHaveBeenCalledWith('id', {
      ascending: true,
      referencedTable: 'case_order_items',
    })
  })

  // issue #20 型安全・データ層整合レビュー対応（important）: SPEC.md Part2 SET-C テスト観点
  // 「limit上限: 最大100（100超は400エラー）、負数は400エラー」の未実装・未テストを解消
  it('limitが100を超える場合はエラーを投げる', async () => {
    const db = { from: vi.fn() } as unknown as SupabaseClient
    await expect(listCaseOrders(db, 'f-1', 101, 0)).rejects.toThrow('limit は 1〜100 の整数で指定してください')
  })

  it('limitが負数の場合はエラーを投げる', async () => {
    const db = { from: vi.fn() } as unknown as SupabaseClient
    await expect(listCaseOrders(db, 'f-1', -1, 0)).rejects.toThrow('limit は 1〜100 の整数で指定してください')
  })

  it('offsetが負数の場合はエラーを投げる', async () => {
    const db = { from: vi.fn() } as unknown as SupabaseClient
    await expect(listCaseOrders(db, 'f-1', 50, -1)).rejects.toThrow('offset は0以上の整数で指定してください')
  })

  it('dateFrom/dateTo を指定すると case_datetime に gte/lte を適用する', async () => {
    const caseOrdersBuilder = makeChainable({ data: [mockRow], error: null })
    const db = { from: vi.fn(() => caseOrdersBuilder) } as unknown as SupabaseClient

    await listCaseOrders(db, 'f-1', 50, 0, { dateFrom: '2026-06-01T00:00:00Z', dateTo: '2026-06-30T23:59:59Z' })

    expect(caseOrdersBuilder.gte).toHaveBeenCalledWith('case_datetime', '2026-06-01T00:00:00Z')
    expect(caseOrdersBuilder.lte).toHaveBeenCalledWith('case_datetime', '2026-06-30T23:59:59Z')
  })

  it('productSearch が空文字/未指定の場合は products / case_order_items を問い合わせない', async () => {
    const caseOrdersBuilder = makeChainable({ data: [mockRow], error: null })
    const from = vi.fn((table: string) => {
      if (table === 'case_orders') return caseOrdersBuilder
      throw new Error(`unexpected table: ${table}`)
    })
    const db = { from } as unknown as SupabaseClient

    await listCaseOrders(db, 'f-1', 50, 0, { productSearch: '   ' })

    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('case_orders')
  })

  it('productSearch を指定すると products→case_order_items 経由で対象IDを絞り込む', async () => {
    const productsBuilder = makeChainable({ data: [{ jan: '490001' }, { jan: '490002' }], error: null })
    const itemsBuilder = makeChainable({ data: [{ case_order_id: 'co-1' }, { case_order_id: 'co-2' }], error: null })
    const caseOrdersBuilder = makeChainable({ data: [mockRow], error: null })
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'products') return productsBuilder
        if (table === 'case_order_items') return itemsBuilder
        if (table === 'case_orders') return caseOrdersBuilder
        throw new Error(`unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    const result = await listCaseOrders(db, 'f-1', 50, 0, { productSearch: 'カテーテル' })

    expect(productsBuilder.select).toHaveBeenCalledWith('jan')
    expect(productsBuilder.ilike).toHaveBeenCalledWith('name', '%カテーテル%')
    expect(itemsBuilder.in).toHaveBeenCalledWith('jan', ['490001', '490002'])
    expect(caseOrdersBuilder.in).toHaveBeenCalledWith('id', ['co-1', 'co-2'])
    expect(result).toHaveLength(1)
  })

  it('productSearch にヒットする製品が無い場合は case_orders を問い合わせず空配列を返す', async () => {
    const productsBuilder = makeChainable({ data: [], error: null })
    const from = vi.fn((table: string) => {
      if (table === 'products') return productsBuilder
      throw new Error(`unexpected table: ${table}`)
    })
    const db = { from } as unknown as SupabaseClient

    const result = await listCaseOrders(db, 'f-1', 50, 0, { productSearch: 'ヒットしない' })

    expect(result).toEqual([])
    expect(from).toHaveBeenCalledTimes(1)
  })

  it('productSearch にヒットする明細が無い場合は空配列を返す', async () => {
    const productsBuilder = makeChainable({ data: [{ jan: '490001' }], error: null })
    const itemsBuilder = makeChainable({ data: [], error: null })
    const from = vi.fn((table: string) => {
      if (table === 'products') return productsBuilder
      if (table === 'case_order_items') return itemsBuilder
      throw new Error(`unexpected table: ${table}`)
    })
    const db = { from } as unknown as SupabaseClient

    const result = await listCaseOrders(db, 'f-1', 50, 0, { productSearch: 'ヒットしない' })

    expect(result).toEqual([])
    expect(from).toHaveBeenCalledTimes(2)
  })

  it('Supabaseエラー時に例外を投げる（メインクエリ）', async () => {
    const caseOrdersBuilder = makeChainable({ data: null, error: { message: 'DB error' } })
    const db = { from: vi.fn(() => caseOrdersBuilder) } as unknown as SupabaseClient

    await expect(listCaseOrders(db, 'f-1', 50, 0)).rejects.toThrow('DB error')
  })

  it('Supabaseエラー時に例外を投げる（productsサブクエリ）', async () => {
    const productsBuilder = makeChainable({ data: null, error: { message: 'products error' } })
    const db = { from: vi.fn(() => productsBuilder) } as unknown as SupabaseClient

    await expect(listCaseOrders(db, 'f-1', 50, 0, { productSearch: 'x' })).rejects.toThrow('products error')
  })
})
