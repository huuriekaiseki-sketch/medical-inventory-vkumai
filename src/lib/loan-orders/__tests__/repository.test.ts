import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { createLoanOrder } from '@/lib/loan-orders/repository'

describe('createLoanOrder', () => {
  const mockRpcResult = {
    id: 'lo-1', facility_id: 'f-1', procedure_name: 'TAVI', maker: 'メドトロニック',
    status: 'draft', created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
    items: [
      { id: 'i-1', loan_order_id: 'lo-1', jan: '490001', name: 'カテーテルA', quantity: 1, created_at: '2026-06-24T00:00:00Z' },
    ],
  }

  beforeEach(async () => {
    vi.resetAllMocks()
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.rpc = vi.fn().mockResolvedValue({ data: mockRpcResult, error: null })
  })

  it('RPC を呼んで LoanOrder を返す', async () => {
    const result = await createLoanOrder('f-1', {
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
    const { supabase } = await import('@/lib/supabase/server')
    const rpc = (supabase as Record<string, unknown>).rpc as ReturnType<typeof vi.fn>

    await createLoanOrder('f-1', {
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
    expect(typeof args.p_items).toBe('string')
    expect(JSON.parse(args.p_items as string)).toEqual([
      { jan: '490001', name: 'カテーテルA', quantity: 1 },
    ])
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } })

    await expect(
      createLoanOrder('f-1', { procedureName: 'TAVI', maker: 'M', items: [] })
    ).rejects.toThrow('DB error')
  })
})
