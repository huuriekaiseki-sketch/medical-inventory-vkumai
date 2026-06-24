import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { createLoanOrder } from '@/lib/loan-orders/repository'

describe('createLoanOrder', () => {
  const mockOrder = {
    id: 'lo-1', facility_id: 'f-1', procedure_name: 'TAVI', maker: 'メドトロニック',
    status: 'draft', created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
  }
  const mockItems = [
    { id: 'i-1', loan_order_id: 'lo-1', jan: '490001', name: 'カテーテルA', quantity: 1, created_at: '2026-06-24T00:00:00Z' },
  ]

  beforeEach(async () => {
    vi.resetAllMocks()
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.from = vi.fn((table: string) => {
      if (table === 'loan_orders') {
        return { insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: mockOrder, error: null }) })) })) }
      }
      if (table === 'loan_order_items') {
        return { insert: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: mockItems, error: null }) })) }
      }
    })
  })

  it('ヘッダーと明細を作成してLoanOrderを返す', async () => {
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
})
