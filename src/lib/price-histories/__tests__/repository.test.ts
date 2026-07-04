import { describe, it, expect, vi } from 'vitest'
import { getPriceHistory, listRecentPriceHistories } from '../repository'
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

describe('listRecentPriceHistories', () => {
  function makeMockQueryDb(result: unknown) {
    const limitFn = vi.fn().mockResolvedValue(result)
    const orderFn = vi.fn(() => ({ limit: limitFn }))
    const selectFn = vi.fn(() => ({ order: orderFn }))
    const fromFn = vi.fn(() => ({ select: selectFn }))
    const db = { from: fromFn } as unknown as SupabaseClient
    return { db, fromFn, selectFn, orderFn, limitFn }
  }

  it('changed_at降順・productName付きでマッピングする', async () => {
    const rows = [
      {
        id: 'hist-1',
        entity_type: 'distributor_product',
        entity_id: 'dp-1',
        distributor_product_id: 'dpi-1',
        field_name: 'reimbursement_price',
        old_value: 100,
        new_value: 120,
        changed_at: '2026-07-03T00:00:00Z',
        distributor_products: { name: '商品A' },
      },
    ]
    const { db, fromFn, orderFn, limitFn } = makeMockQueryDb({ data: rows, error: null })

    const result = await listRecentPriceHistories(db, 10)

    expect(fromFn).toHaveBeenCalledWith('price_histories')
    expect(orderFn).toHaveBeenCalledWith('changed_at', { ascending: false })
    expect(limitFn).toHaveBeenCalledWith(10)
    expect(result).toEqual([
      {
        id: 'hist-1',
        entityType: 'distributor_product',
        entityId: 'dp-1',
        distributorProductId: 'dpi-1',
        fieldName: 'reimbursement_price',
        oldValue: 100,
        newValue: 120,
        changedAt: '2026-07-03T00:00:00Z',
        facilityName: null,
        productName: '商品A',
      },
    ])
  })

  it('デフォルトlimitは10件', async () => {
    const { db, limitFn } = makeMockQueryDb({ data: [], error: null })
    await listRecentPriceHistories(db)
    expect(limitFn).toHaveBeenCalledWith(10)
  })

  it('0件の場合は空配列を返す', async () => {
    const { db } = makeMockQueryDb({ data: [], error: null })
    const result = await listRecentPriceHistories(db)
    expect(result).toEqual([])
  })

  it('distributor_productsがnullの場合はproductNameがnullになる', async () => {
    const rows = [
      {
        id: 'hist-2',
        entity_type: 'hospital_price',
        entity_id: 'hp-1',
        distributor_product_id: 'dpi-2',
        field_name: 'purchase_price',
        old_value: null,
        new_value: 50,
        changed_at: '2026-07-01T00:00:00Z',
        distributor_products: null,
      },
    ]
    const { db } = makeMockQueryDb({ data: rows, error: null })
    const result = await listRecentPriceHistories(db)
    expect(result[0].productName).toBeNull()
  })

  it('エラー時は例外を投げる', async () => {
    const { db } = makeMockQueryDb({ data: null, error: { message: 'query failed' } })
    await expect(listRecentPriceHistories(db)).rejects.toThrow('query failed')
  })
})
