import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { createConsumableOrder } from '@/lib/consumable-orders/repository'

describe('createConsumableOrder', () => {
  const mockOrder = {
    id: 'coo-1', facility_id: 'f-1', status: 'draft',
    created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
  }
  const mockItems = [
    { id: 'i-1', consumable_order_id: 'coo-1', consumable_id: 'c-1', quantity: 3, created_at: '2026-06-24T00:00:00Z' },
  ]

  beforeEach(async () => {
    vi.resetAllMocks()
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.from = vi.fn((table: string) => {
      if (table === 'consumable_orders') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: mockOrder, error: null }),
            })),
          })),
        }
      }
      if (table === 'consumable_order_items') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn().mockResolvedValue({ data: mockItems, error: null }),
          })),
        }
      }
    })
  })

  it('ヘッダーと明細を作成してConsumableOrderを返す', async () => {
    const result = await createConsumableOrder('f-1', {
      items: [{ consumableId: 'c-1', quantity: 3 }],
    })
    expect(result.id).toBe('coo-1')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].consumableId).toBe('c-1')
    expect(result.items[0].quantity).toBe(3)
  })
})
