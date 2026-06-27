import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLoanReturn } from '@/lib/loan-returns/repository'

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
})
