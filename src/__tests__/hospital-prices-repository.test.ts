import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { listHospitalPrices, getHospitalPrice } from '@/lib/hospital-prices/repository'

describe('listHospitalPrices / getHospitalPrice', () => {
  const mockRow = {
    id: 'hp-123',
    distributor_product_id: 'dp-456',
    facility_id: 'f-789',
    purchase_price: '1000.50',
    delivery_price: '500.25',
    gross_profit: '2000.75',
    purchase_rate: '0.8',
    delivery_rate: '0.96',
    created_at: '2026-06-23T00:00:00Z',
    updated_at: '2026-06-23T00:00:00Z',
  }

  beforeEach(async () => {
    vi.resetAllMocks()
    const { supabase } = await import('@/lib/supabase/server')
    // Setup default mock
    const mockSupabase = supabase as Record<string, unknown>
    mockSupabase.from = vi.fn(() => ({
      select: vi.fn(() => ({
        order: vi.fn().mockResolvedValue({
          data: [mockRow],
          error: null,
        }),
      })),
    }))
  })

  it('should map database row with all fields including grossProfit, purchaseRate, and deliveryRate', async () => {
    const result = await listHospitalPrices()

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      id: 'hp-123',
      distributorProductId: 'dp-456',
      facilityId: 'f-789',
      purchasePrice: 1000.50,
      deliveryPrice: 500.25,
      grossProfit: 2000.75,
      purchaseRate: 0.8,
      deliveryRate: 0.96,
      createdAt: '2026-06-23T00:00:00Z',
      updatedAt: '2026-06-23T00:00:00Z',
    })
  })

  it('should handle null purchaseRate and deliveryRate', async () => {
    const { supabase } = await import('@/lib/supabase/server')
    const rowWithNulls = {
      ...mockRow,
      purchase_rate: null,
      delivery_rate: null,
    }
    const mockSupabase = supabase as Record<string, unknown>
    mockSupabase.from = vi.fn(() => ({
      select: vi.fn(() => ({
        order: vi.fn().mockResolvedValue({
          data: [rowWithNulls],
          error: null,
        }),
      })),
    }))

    const result = await listHospitalPrices()

    expect(result).toHaveLength(1)
    expect(result[0].purchaseRate).toBeNull()
    expect(result[0].deliveryRate).toBeNull()
  })

  it('should map single hospital price with all fields', async () => {
    const { supabase } = await import('@/lib/supabase/server')
    const mockSupabase = supabase as Record<string, unknown>
    mockSupabase.from = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({
            data: mockRow,
            error: null,
          }),
        })),
      })),
    }))

    const result = await getHospitalPrice('hp-123')

    expect(result).toEqual({
      id: 'hp-123',
      distributorProductId: 'dp-456',
      facilityId: 'f-789',
      purchasePrice: 1000.50,
      deliveryPrice: 500.25,
      grossProfit: 2000.75,
      purchaseRate: 0.8,
      deliveryRate: 0.96,
      createdAt: '2026-06-23T00:00:00Z',
      updatedAt: '2026-06-23T00:00:00Z',
    })
  })
})
