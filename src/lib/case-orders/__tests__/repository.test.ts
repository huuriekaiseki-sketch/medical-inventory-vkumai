import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { createCaseOrder } from '@/lib/case-orders/repository'

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

  beforeEach(async () => {
    vi.resetAllMocks()
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.rpc = vi.fn().mockResolvedValue({ data: mockRpcResult, error: null })
  })

  it('RPC を呼んで CaseOrder を返す', async () => {
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

  it('create_case_order_atomic を正しい引数で呼ぶ', async () => {
    const { supabase } = await import('@/lib/supabase/server')
    const rpc = (supabase as Record<string, unknown>).rpc as ReturnType<typeof vi.fn>

    await createCaseOrder('f-1', {
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
    // items は JSON 文字列で渡す
    expect(typeof args.p_items).toBe('string')
    expect(JSON.parse(args.p_items as string)).toEqual([
      { jan: '4901234567890', lot: 'L001', ubd: '2027-01', quantity: 2 },
    ])
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } })

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
