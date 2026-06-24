import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { createCaseOrder } from '@/lib/case-orders/repository'

describe('createCaseOrder', () => {
  const mockOrder = {
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
  }
  const mockItems = [
    { id: 'i-1', case_order_id: 'co-1', jan: '4901234567890', lot: 'L001', ubd: '2027-01', quantity: 2, created_at: '2026-06-24T00:00:00Z' },
  ]

  beforeEach(async () => {
    vi.resetAllMocks()
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.from = vi.fn((table: string) => {
      if (table === 'case_orders') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: mockOrder, error: null }),
            })),
          })),
        }
      }
      if (table === 'case_order_items') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn().mockResolvedValue({ data: mockItems, error: null }),
          })),
        }
      }
    })
  })

  it('ヘッダーと明細を作成してCaseOrderを返す', async () => {
    const result = await createCaseOrder('f-1', {
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

  it('Supabaseエラー時に例外を投げる', async () => {
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.from = vi.fn(() => ({
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }),
        })),
      })),
    }))

    await expect(
      createCaseOrder('f-1', {
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
})
