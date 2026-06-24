import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { listConsumablesByFacility, createConsumable } from '@/lib/consumables/repository'

describe('consumables repository', () => {
  const mockRow = {
    id: 'c-1', facility_id: 'f-1', name: 'ガーゼ', jan: '4900000000001', purpose: '止血',
    created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
  }

  beforeEach(async () => {
    vi.resetAllMocks()
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.from = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn().mockResolvedValue({ data: [mockRow], error: null }),
        })),
      })),
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: mockRow, error: null }),
        })),
      })),
    }))
  })

  it('listConsumablesByFacilityがConsumable[]を返す', async () => {
    const result = await listConsumablesByFacility('f-1')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      id: 'c-1', facilityId: 'f-1', name: 'ガーゼ', jan: '4900000000001', purpose: '止血',
      createdAt: '2026-06-24T00:00:00Z', updatedAt: '2026-06-24T00:00:00Z',
    })
  })

  it('createConsumableがConsumableを返す', async () => {
    const result = await createConsumable('f-1', { name: 'ガーゼ', jan: '4900000000001', purpose: '止血' })
    expect(result.id).toBe('c-1')
    expect(result.name).toBe('ガーゼ')
  })
})
