import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchOrderAmountReport } from '@/lib/reports/repository'

function makeMockRpcDb(rpcResult: { data: unknown; error: unknown }): { db: SupabaseClient; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn().mockResolvedValue(rpcResult)
  const db = { rpc } as unknown as SupabaseClient
  return { db, rpc }
}

describe('fetchOrderAmountReport', () => {
  it('RPCを正しい引数(JST日境界のTIMESTAMPTZ)で呼び出す', async () => {
    const { db, rpc } = makeMockRpcDb({ data: [], error: null })

    await fetchOrderAmountReport(db, { dateFrom: '2026-07-01', dateTo: '2026-07-31' })

    expect(rpc).toHaveBeenCalledWith('get_order_amount_report', {
      p_date_from: '2026-07-01T00:00:00+09:00',
      p_date_to: '2026-07-31T23:59:59+09:00',
    })
  })

  it('dateFrom/dateTo省略時はnullを渡す', async () => {
    const { db, rpc } = makeMockRpcDb({ data: [], error: null })

    await fetchOrderAmountReport(db, {})

    expect(rpc).toHaveBeenCalledWith('get_order_amount_report', {
      p_date_from: null,
      p_date_to: null,
    })
  })

  it('全フィールドをスネークケースからキャメルケースへマッピングする（*_total_countも含む）', async () => {
    const rpcRow = {
      facility_id: 'f-1',
      facility_name: 'テスト施設A',
      case_order_amount: 12345,
      case_order_count: 3,
      case_order_total_count: 3,
      consumable_order_amount: null,
      consumable_order_count: 0,
      consumable_order_total_count: 5,
      loan_order_amount: 0,
      loan_order_count: 2,
      loan_order_total_count: 2,
    }
    const { db } = makeMockRpcDb({ data: [rpcRow], error: null })

    const result = await fetchOrderAmountReport(db, {})

    expect(result).toEqual([
      {
        facilityId: 'f-1',
        facilityName: 'テスト施設A',
        caseOrderAmount: 12345,
        caseOrderCount: 3,
        caseOrderTotalCount: 3,
        consumableOrderAmount: null,
        consumableOrderCount: 0,
        consumableOrderTotalCount: 5,
        loanOrderAmount: 0,
        loanOrderCount: 2,
        loanOrderTotalCount: 2,
      },
    ])
  })

  it('data=nullの場合は空配列を返す', async () => {
    const { db } = makeMockRpcDb({ data: null, error: null })

    const result = await fetchOrderAmountReport(db, {})

    expect(result).toEqual([])
  })

  it('RPCがエラーを返した場合はthrowする', async () => {
    const { db } = makeMockRpcDb({ data: null, error: { message: 'permission denied' } })

    await expect(fetchOrderAmountReport(db, {})).rejects.toThrow('permission denied')
  })
})
