import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLoanReturn, listLoanReturns, LOAN_ORDER_NOT_FOUND_ERROR } from '@/lib/loan-returns/repository'

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

// WHY: createLoanReturn は loanOrderId 指定時に「facilityIdに属するloan_orderか」を
//      db.from('loan_orders').select('id').eq('id', ...).eq('facility_id', ...).maybeSingle()
//      で検証する（issue #20 レビュー指摘: critical テナント境界チェック）。この検証クエリを
//      モックするヘルパー
function makeLoanOrderLookupTable(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn().mockResolvedValue(result),
  }
  return builder
}

describe('createLoanReturn', () => {
  const mockReturn = {
    id: 'lr-1', facility_id: 'f-1', return_datetime: '2026-06-24T15:00:00Z',
    status: 'draft', created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
  }
  const mockItems = [
    { id: 'i-1', loan_return_id: 'lr-1', jan: '490001', lot: 'L001', ubd: '2027-01', quantity: 1, created_at: '2026-06-24T00:00:00Z' },
  ]

  it('ヘッダーと明細を作成してLoanReturnを返す', async () => {
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'loan_returns') {
          return { insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: mockReturn, error: null }) })) })) }
        }
        if (table === 'loan_return_items') {
          return { insert: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: mockItems, error: null }) })) }
        }
      }),
    } as unknown as SupabaseClient

    const result = await createLoanReturn(db, 'f-1', {
      returnDatetime: '2026-06-24T15:00:00Z',
      items: [{ jan: '490001', lot: 'L001', ubd: '2027-01', quantity: 1 }],
    })
    expect(result.id).toBe('lr-1')
    expect(result.status).toBe('draft')
    expect(result.items[0].jan).toBe('490001')
  })

  it('loanOrderIdを指定すると loan_returns の insert に loan_order_id として渡る（未返却誤判定バグの修正）', async () => {
    const insertLoanReturns = vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: { ...mockReturn, loan_order_id: 'lo-1' }, error: null }) })) }))
    const loanOrders = makeLoanOrderLookupTable({ data: { id: 'lo-1' }, error: null })
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'loan_orders') return loanOrders
        if (table === 'loan_returns') {
          return { insert: insertLoanReturns }
        }
        if (table === 'loan_return_items') {
          return { insert: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: mockItems, error: null }) })) }
        }
      }),
    } as unknown as SupabaseClient

    const result = await createLoanReturn(db, 'f-1', {
      returnDatetime: '2026-06-24T15:00:00Z',
      items: [{ jan: '490001', lot: 'L001', ubd: '2027-01', quantity: 1 }],
    }, 'lo-1')

    // WHY: 他施設のloan_orderへの紐付けを防ぐため、insert前にfacilityId込みで存在確認する
    //      （issue #20 レビュー指摘: critical テナント境界チェック）
    expect(loanOrders.eq).toHaveBeenCalledWith('id', 'lo-1')
    expect(loanOrders.eq).toHaveBeenCalledWith('facility_id', 'f-1')
    expect(insertLoanReturns).toHaveBeenCalledWith(expect.objectContaining({ loan_order_id: 'lo-1' }))
    expect(result.loanOrderId).toBe('lo-1')
  })

  it('loanOrderIdが自施設に存在しない場合（他施設のIDを指定した場合を含む）はエラーを投げてinsertしない', async () => {
    const insertLoanReturns = vi.fn()
    const loanOrders = makeLoanOrderLookupTable({ data: null, error: null })
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'loan_orders') return loanOrders
        if (table === 'loan_returns') return { insert: insertLoanReturns }
      }),
    } as unknown as SupabaseClient

    await expect(
      createLoanReturn(db, 'f-1', {
        returnDatetime: '2026-06-24T15:00:00Z',
        items: [{ jan: '490001', lot: 'L001', ubd: '2027-01', quantity: 1 }],
      }, 'other-facility-lo')
    ).rejects.toThrow(LOAN_ORDER_NOT_FOUND_ERROR)
    expect(insertLoanReturns).not.toHaveBeenCalled()
  })

  it('loanOrderIdを指定しない場合は loan_order_id: null で insert される（既存呼び出し元互換）', async () => {
    const insertLoanReturns = vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: mockReturn, error: null }) })) }))
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'loan_returns') {
          return { insert: insertLoanReturns }
        }
        if (table === 'loan_return_items') {
          return { insert: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: mockItems, error: null }) })) }
        }
      }),
    } as unknown as SupabaseClient

    await createLoanReturn(db, 'f-1', {
      returnDatetime: '2026-06-24T15:00:00Z',
      items: [{ jan: '490001', lot: 'L001', ubd: '2027-01', quantity: 1 }],
    })

    expect(insertLoanReturns).toHaveBeenCalledWith(expect.objectContaining({ loan_order_id: null }))
  })

  it('DBのstatusが想定外の値の場合はdraftにフォールバックする', async () => {
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'loan_returns') {
          return { insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: { ...mockReturn, status: 'invalid' }, error: null }) })) })) }
        }
        if (table === 'loan_return_items') {
          return { insert: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: mockItems, error: null }) })) }
        }
      }),
    } as unknown as SupabaseClient

    const result = await createLoanReturn(db, 'f-1', {
      returnDatetime: '2026-06-24T15:00:00Z',
      items: [{ jan: '490001', lot: 'L001', ubd: '2027-01', quantity: 1 }],
    })
    expect(result.status).toBe('draft')
  })
})

describe('listLoanReturns', () => {
  const rows = [
    {
      id: 'lr-1', facility_id: 'f-1', return_datetime: '2026-06-24T15:00:00Z',
      status: 'returned', created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
      loan_order_id: 'lo-1',
      loan_return_items: [{ id: 'i-1', loan_return_id: 'lr-1', jan: '490001', lot: null, ubd: null, quantity: 1, created_at: '2026-06-24T00:00:00Z' }],
    },
    {
      id: 'lr-2', facility_id: 'f-1', return_datetime: '2026-06-25T15:00:00Z',
      status: 'draft', created_at: '2026-06-25T00:00:00Z', updated_at: '2026-06-25T00:00:00Z',
      loan_order_id: null,
      loan_return_items: [{ id: 'i-2', loan_return_id: 'lr-2', jan: '490002', lot: null, ubd: null, quantity: 1, created_at: '2026-06-25T00:00:00Z' }],
    },
  ]

  it('デフォルト引数（filterなし）で一覧を返す', async () => {
    const { db } = makeMockListDb({ data: rows, error: null })
    const result = await listLoanReturns(db, 'f-1')
    expect(result).toHaveLength(2)
  })

  it('loanOrderId フィールドをマッピングする（存在する場合は文字列、存在しない場合はundefined）', async () => {
    const { db } = makeMockListDb({ data: rows, error: null })
    const result = await listLoanReturns(db, 'f-1')
    expect(result[0].loanOrderId).toBe('lo-1')
    expect(result[1].loanOrderId).toBeUndefined()
  })

  it('filter未指定時はrangeで従来通りページングする', async () => {
    const { db, query } = makeMockListDb({ data: rows, error: null })
    await listLoanReturns(db, 'f-1', 10, 5)
    expect(query.range).toHaveBeenCalledWith(5, 14)
  })

  it('keywordがitems[].janに一致する行のみ返す', async () => {
    const { db } = makeMockListDb({ data: rows, error: null })
    const result = await listLoanReturns(db, 'f-1', 50, 0, { keyword: '490002' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('lr-2')
  })

  it('dateFrom/dateToはJSTの日境界でgte/lteに変換される', async () => {
    const { db, query } = makeMockListDb({ data: rows, error: null })
    await listLoanReturns(db, 'f-1', 50, 0, { dateFrom: '2026-06-24', dateTo: '2026-06-25' })
    expect(query.gte).toHaveBeenCalledWith('created_at', '2026-06-24T00:00:00+09:00')
    expect(query.lte).toHaveBeenCalledWith('created_at', '2026-06-25T23:59:59+09:00')
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const { db } = makeMockListDb({ data: null, error: { message: 'DB error' } })
    await expect(listLoanReturns(db, 'f-1')).rejects.toThrow('DB error')
  })
})
