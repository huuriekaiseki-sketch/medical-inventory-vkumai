import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { createConsumableOrder } from '@/lib/consumable-orders/repository'

describe('createConsumableOrder', () => {
  const mockRpcResult = {
    id: 'coo-1', facility_id: 'f-1', status: 'draft',
    created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
    items: [
      { id: 'i-1', consumable_order_id: 'coo-1', consumable_id: 'c-1', quantity: 3, created_at: '2026-06-24T00:00:00Z' },
    ],
  }

  beforeEach(async () => {
    vi.resetAllMocks()
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.rpc = vi.fn().mockResolvedValue({ data: mockRpcResult, error: null })
  })

  it('RPC を呼んで ConsumableOrder を返す', async () => {
    const result = await createConsumableOrder('f-1', {
      items: [{ consumableId: 'c-1', quantity: 3 }],
    })
    expect(result.id).toBe('coo-1')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].consumableId).toBe('c-1')
    expect(result.items[0].quantity).toBe(3)
  })

  it('create_consumable_order_atomic を正しい引数で呼ぶ', async () => {
    const { supabase } = await import('@/lib/supabase/server')
    const rpc = (supabase as Record<string, unknown>).rpc as ReturnType<typeof vi.fn>

    await createConsumableOrder('f-1', { items: [{ consumableId: 'c-1', quantity: 3 }] })

    expect(rpc).toHaveBeenCalledWith('create_consumable_order_atomic', expect.objectContaining({
      p_facility_id: 'f-1',
    }))
    const args = rpc.mock.calls[0][1] as Record<string, unknown>
    expect(typeof args.p_items).toBe('string')
    expect(JSON.parse(args.p_items as string)).toEqual([
      { consumable_id: 'c-1', quantity: 3 },
    ])
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } })

    await expect(
      createConsumableOrder('f-1', { items: [] })
    ).rejects.toThrow('DB error')
  })
})
