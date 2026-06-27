import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getPriceHistory } from '../repository'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeMockDb(rpcResult: unknown): SupabaseClient {
  return { rpc: vi.fn().mockResolvedValueOnce(rpcResult) } as unknown as SupabaseClient
}

describe('getPriceHistory', () => {
  it('should map RPC response with dist_product_id correctly', async () => {
    const mockData = [
      {
        id: 'hist-1',
        entity_type: 'distributor_product',
        entity_id: 'dp-1',
        dist_product_id: 'dpi-123',
        field_name: 'reimbursement_price',
        old_value: 100,
        new_value: 110,
        changed_at: '2026-06-22T10:00:00Z',
        facility_name: null,
      },
      {
        id: 'hist-2',
        entity_type: 'hospital_price',
        entity_id: 'hp-1',
        dist_product_id: 'dpi-123',
        field_name: 'purchase_price',
        old_value: 80,
        new_value: 85,
        changed_at: '2026-06-22T11:00:00Z',
        facility_name: '病院A',
      },
    ]
    const db = makeMockDb({ data: mockData, error: null })
    const result = await getPriceHistory(db, 'dpi-123')

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      id: 'hist-1',
      entityType: 'distributor_product',
      entityId: 'dp-1',
      distributorProductId: 'dpi-123',
      fieldName: 'reimbursement_price',
      oldValue: 100,
      newValue: 110,
      changedAt: '2026-06-22T10:00:00Z',
      facilityName: null,
    })
    expect(result[1].facilityName).toBe('病院A')
    expect((db.rpc as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'get_distributor_product_price_history',
      { p_distributor_product_id: 'dpi-123' }
    )
  })

  it('should handle null values in old_value and new_value', async () => {
    const mockData = [
      {
        id: 'hist-3',
        entity_type: 'distributor_product',
        entity_id: 'dp-2',
        dist_product_id: 'dpi-456',
        field_name: 'delivery_price',
        old_value: null,
        new_value: 50,
        changed_at: '2026-06-22T12:00:00Z',
        facility_name: null,
      },
    ]
    const db = makeMockDb({ data: mockData, error: null })
    const result = await getPriceHistory(db, 'dpi-456')

    expect(result[0].oldValue).toBeNull()
    expect(result[0].newValue).toBe(50)
  })

  it('should throw error when RPC fails', async () => {
    const db = makeMockDb({ data: null, error: { message: 'Database error' } })
    await expect(getPriceHistory(db, 'dpi-789')).rejects.toThrow('Database error')
  })

  it('should return empty array when no records found', async () => {
    const db = makeMockDb({ data: [], error: null })
    const result = await getPriceHistory(db, 'dpi-nonexistent')
    expect(result).toEqual([])
  })
})
