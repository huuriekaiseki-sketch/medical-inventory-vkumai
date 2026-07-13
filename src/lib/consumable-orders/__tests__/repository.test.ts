import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createConsumableOrder } from '@/lib/consumable-orders/repository'

function makeMockRpcDb(rpcResult: unknown): SupabaseClient {
  return { rpc: vi.fn().mockResolvedValue(rpcResult) } as unknown as SupabaseClient
}

describe('createConsumableOrder', () => {
  const mockRpcResult = {
    id: 'coo-1', facility_id: 'f-1', status: 'draft',
    created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
    items: [
      { id: 'i-1', consumable_order_id: 'coo-1', consumable_id: 'c-1', quantity: 3, created_at: '2026-06-24T00:00:00Z' },
    ],
  }

  it('RPC を呼んで ConsumableOrder を返す', async () => {
    const db = makeMockRpcDb({ data: mockRpcResult, error: null })
    const result = await createConsumableOrder(db, 'f-1', {
      items: [{ consumableId: 'c-1', quantity: 3 }],
    })
    expect(result.id).toBe('coo-1')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].consumableId).toBe('c-1')
    expect(result.items[0].quantity).toBe(3)
  })

  it('create_consumable_order_atomic を正しい引数で呼ぶ', async () => {
    const db = makeMockRpcDb({ data: mockRpcResult, error: null })
    const rpc = db.rpc as ReturnType<typeof vi.fn>

    await createConsumableOrder(db, 'f-1', { items: [{ consumableId: 'c-1', quantity: 3 }] })

    expect(rpc).toHaveBeenCalledWith('create_consumable_order_atomic', expect.objectContaining({
      p_facility_id: 'f-1',
    }))
    const args = rpc.mock.calls[0][1] as Record<string, unknown>
    // p_items はJSONB引数のため配列のまま渡す（JSON.stringifyしない。issue #287）
    expect(args.p_items).toEqual([
      { consumable_id: 'c-1', quantity: 3 },
    ])
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const db = makeMockRpcDb({ data: null, error: { message: 'DB error' } })

    await expect(
      createConsumableOrder(db, 'f-1', { items: [] })
    ).rejects.toThrow('DB error')
  })

  it('DBのstatusが想定外の値の場合はdraftにフォールバックする', async () => {
    const db = makeMockRpcDb({ data: { ...mockRpcResult, status: 'invalid' }, error: null })
    const result = await createConsumableOrder(db, 'f-1', { items: [] })
    expect(result.status).toBe('draft')
  })
})
