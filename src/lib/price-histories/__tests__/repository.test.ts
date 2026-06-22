import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase before importing repository
vi.mock('@/lib/supabase/server', () => ({
  supabase: {
    rpc: vi.fn(),
  },
}))

import { getPriceHistory } from '../repository'
import { supabase } from '@/lib/supabase/server'

describe('getPriceHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

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

    vi.mocked(supabase.rpc).mockResolvedValueOnce({
      data: mockData,
      error: null,
    } as { data: Record<string, unknown>[]; error: null })

    const result = await getPriceHistory('dpi-123')

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
    expect(result[1]).toEqual({
      id: 'hist-2',
      entityType: 'hospital_price',
      entityId: 'hp-1',
      distributorProductId: 'dpi-123',
      fieldName: 'purchase_price',
      oldValue: 80,
      newValue: 85,
      changedAt: '2026-06-22T11:00:00Z',
      facilityName: '病院A',
    })

    expect(supabase.rpc).toHaveBeenCalledWith(
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

    vi.mocked(supabase.rpc).mockResolvedValueOnce({
      data: mockData,
      error: null,
    } as { data: Record<string, unknown>[]; error: null })

    const result = await getPriceHistory('dpi-456')

    expect(result[0]).toEqual({
      id: 'hist-3',
      entityType: 'distributor_product',
      entityId: 'dp-2',
      distributorProductId: 'dpi-456',
      fieldName: 'delivery_price',
      oldValue: null,
      newValue: 50,
      changedAt: '2026-06-22T12:00:00Z',
      facilityName: null,
    })
  })

  it('should throw error when RPC fails', async () => {
    vi.mocked(supabase.rpc).mockResolvedValueOnce({
      data: null,
      error: { message: 'Database error' },
    } as { data: null; error: { message: string } })

    await expect(getPriceHistory('dpi-789')).rejects.toThrow('Database error')
  })

  it('should return empty array when no records found', async () => {
    vi.mocked(supabase.rpc).mockResolvedValueOnce({
      data: [],
      error: null,
    } as { data: Record<string, unknown>[]; error: null })

    const result = await getPriceHistory('dpi-nonexistent')

    expect(result).toEqual([])
  })
})
