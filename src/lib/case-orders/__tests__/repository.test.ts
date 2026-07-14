import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createCaseOrder, listCaseOrders } from '@/lib/case-orders/repository'

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

// WHY: db.from() は listCaseOrders 内部で1回だけ呼ばれる前提のため、
//      呼び出しごとに新しいbuilderを生成せず、同一builderを返して
//      テスト側から `query` としてアサーションできるようにする
function makeMockListDb(result: { data: unknown; error: unknown }): { db: SupabaseClient; query: ReturnType<typeof makeChainableQuery> } {
  const query = makeChainableQuery(result)
  const db = { from: vi.fn(() => query) } as unknown as SupabaseClient
  return { db, query }
}

function makeMockRpcDb(rpcResult: unknown): SupabaseClient {
  return { rpc: vi.fn().mockResolvedValue(rpcResult) } as unknown as SupabaseClient
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

describe('listCaseOrders', () => {
  const rows = [
    {
      id: 'co-1', facility_id: 'f-1', case_datetime: '2026-06-24T10:00:00Z',
      procedure_name: 'TAVI', patient_id: 'P001', patient_initials: 'T.S.',
      gender: 'male', doctor_name: '田中医師', status: 'submitted',
      created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
      case_order_items: [{ id: 'i-1', case_order_id: 'co-1', jan: '4901234567890', lot: null, ubd: null, quantity: 1, created_at: '2026-06-24T00:00:00Z' }],
    },
    {
      id: 'co-2', facility_id: 'f-1', case_datetime: '2026-06-25T10:00:00Z',
      procedure_name: 'PCI', patient_id: 'P002', patient_initials: 'A.B.',
      gender: 'female', doctor_name: '鈴木医師', status: 'draft',
      created_at: '2026-06-25T00:00:00Z', updated_at: '2026-06-25T00:00:00Z',
      case_order_items: [{ id: 'i-2', case_order_id: 'co-2', jan: '4909999999999', lot: null, ubd: null, quantity: 3, created_at: '2026-06-25T00:00:00Z' }],
    },
  ]

  it('デフォルト引数（filterなし）で一覧を返す', async () => {
    const { db } = makeMockListDb({ data: rows, error: null })
    const result = await listCaseOrders(db, 'f-1')
    expect(result).toHaveLength(2)
    expect(result[0].procedureName).toBe('TAVI')
  })

  it('filter未指定時はrangeで従来通りページングする', async () => {
    const { db, query } = makeMockListDb({ data: rows, error: null })
    await listCaseOrders(db, 'f-1', 10, 5)
    expect(query.range).toHaveBeenCalledWith(5, 14)
  })

  it('keywordがprocedure_nameに一致する行のみ返す', async () => {
    const { db } = makeMockListDb({ data: rows, error: null })
    const result = await listCaseOrders(db, 'f-1', 50, 0, { keyword: 'TAVI' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('co-1')
  })

  it('keywordがitemsのjanに一致する行も返す（procedure_nameに一致しなくても）', async () => {
    const { db } = makeMockListDb({ data: rows, error: null })
    const result = await listCaseOrders(db, 'f-1', 50, 0, { keyword: '4909999999999' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('co-2')
  })

  it('dateFrom/dateToはJSTの日境界でgte/lteに変換される', async () => {
    const { db, query } = makeMockListDb({ data: rows, error: null })
    await listCaseOrders(db, 'f-1', 50, 0, { dateFrom: '2026-06-24', dateTo: '2026-06-25' })
    expect(query.gte).toHaveBeenCalledWith('created_at', '2026-06-24T00:00:00+09:00')
    expect(query.lte).toHaveBeenCalledWith('created_at', '2026-06-25T23:59:59+09:00')
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const { db } = makeMockListDb({ data: null, error: { message: 'DB error' } })
    await expect(listCaseOrders(db, 'f-1')).rejects.toThrow('DB error')
  })
})
