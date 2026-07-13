import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createCaseOrder } from '@/lib/case-orders/repository'

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
