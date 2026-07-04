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
  // WHY: price_histories と hospital_prices の2テーブルにクエリが分かれるため、
  // fromFn をテーブル名で分岐させたモックにする
  function makeMockDb(priceHistoriesResult: unknown, hospitalPricesResult: unknown = { data: [], error: null }) {
    const priceHistoriesLimitFn = vi.fn().mockResolvedValue(priceHistoriesResult)
    const orderFn = vi.fn(() => ({ limit: priceHistoriesLimitFn }))
    const priceHistoriesSelectFn = vi.fn(() => ({ order: orderFn }))

    const hospitalPricesInFn = vi.fn().mockResolvedValue(hospitalPricesResult)
    const hospitalPricesSelectFn = vi.fn(() => ({ in: hospitalPricesInFn }))

    const fromFn = vi.fn((table: string) => {
      if (table === 'hospital_prices') return { select: hospitalPricesSelectFn }
      return { select: priceHistoriesSelectFn }
    })
    const db = { from: fromFn } as unknown as SupabaseClient
    return { db, fromFn, orderFn, priceHistoriesLimitFn, hospitalPricesSelectFn, hospitalPricesInFn }
  }

  it('changed_at降順・productName付きでマッピングする（distributor_productは施設非依存で常に含まれる）', async () => {
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
    const { db, fromFn, orderFn, priceHistoriesLimitFn } = makeMockDb({ data: rows, error: null })

    const result = await listRecentPriceHistories(db, ['f1'], 10)

    expect(fromFn).toHaveBeenCalledWith('price_histories')
    expect(orderFn).toHaveBeenCalledWith('changed_at', { ascending: false })
    expect(priceHistoriesLimitFn).toHaveBeenCalledWith(30)
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

  it('デフォルトlimitは10件（内部フェッチは limit*3 件）', async () => {
    const { db, priceHistoriesLimitFn } = makeMockDb({ data: [], error: null })
    await listRecentPriceHistories(db, ['f1'])
    expect(priceHistoriesLimitFn).toHaveBeenCalledWith(30)
  })

  it('limitを超える件数がフィルタ後も残る場合は先頭limit件に丸める', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `hist-${i}`,
      entity_type: 'distributor_product',
      entity_id: `dp-${i}`,
      distributor_product_id: `dpi-${i}`,
      field_name: 'reimbursement_price',
      old_value: 100,
      new_value: 120,
      changed_at: `2026-07-0${i + 1}T00:00:00Z`,
      distributor_products: { name: `商品${i}` },
    }))
    const { db } = makeMockDb({ data: rows, error: null })
    const result = await listRecentPriceHistories(db, ['f1'], 2)
    expect(result).toHaveLength(2)
  })

  it('0件の場合は空配列を返す', async () => {
    const { db } = makeMockDb({ data: [], error: null })
    const result = await listRecentPriceHistories(db, ['f1'])
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
    const { db } = makeMockDb(
      { data: rows, error: null },
      { data: [{ id: 'hp-1', facility_id: 'f1' }], error: null }
    )
    const result = await listRecentPriceHistories(db, ['f1'])
    expect(result[0].productName).toBeNull()
  })

  it('不正なentity_type/field_nameはフォールバック値になる（unsafe castを使わない）', async () => {
    const rows = [
      {
        id: 'hist-bad',
        entity_type: 'unknown_type',
        entity_id: 'dp-1',
        distributor_product_id: 'dpi-1',
        field_name: 'unknown_field',
        old_value: 1,
        new_value: 2,
        changed_at: '2026-07-03T00:00:00Z',
        distributor_products: { name: '商品A' },
      },
    ]
    const { db } = makeMockDb({ data: rows, error: null })
    const result = await listRecentPriceHistories(db, ['f1'])
    expect(result[0].entityType).toBe('distributor_product')
    expect(result[0].fieldName).toBe('reimbursement_price')
  })

  it('hospital_price行は自分の施設のものだけ残る（他施設のhospital_price行は除外）', async () => {
    const rows = [
      {
        id: 'hist-own',
        entity_type: 'hospital_price',
        entity_id: 'hp-own',
        distributor_product_id: 'dpi-1',
        field_name: 'purchase_price',
        old_value: 100,
        new_value: 110,
        changed_at: '2026-07-03T00:00:00Z',
        distributor_products: { name: '商品A' },
      },
      {
        id: 'hist-other',
        entity_type: 'hospital_price',
        entity_id: 'hp-other',
        distributor_product_id: 'dpi-2',
        field_name: 'purchase_price',
        old_value: 200,
        new_value: 210,
        changed_at: '2026-07-02T00:00:00Z',
        distributor_products: { name: '商品B' },
      },
    ]
    const { db, hospitalPricesInFn } = makeMockDb(
      { data: rows, error: null },
      {
        data: [
          { id: 'hp-own', facility_id: 'f1' },
          { id: 'hp-other', facility_id: 'f2' },
        ],
        error: null,
      }
    )
    const result = await listRecentPriceHistories(db, ['f1'])
    expect(hospitalPricesInFn).toHaveBeenCalledWith('id', ['hp-own', 'hp-other'])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('hist-own')
  })

  it('distributor_product行は施設に関わらず常に含まれる', async () => {
    const rows = [
      {
        id: 'hist-global',
        entity_type: 'distributor_product',
        entity_id: 'dp-1',
        distributor_product_id: 'dpi-1',
        field_name: 'reimbursement_price',
        old_value: 100,
        new_value: 110,
        changed_at: '2026-07-03T00:00:00Z',
        distributor_products: { name: '商品A' },
      },
    ]
    const { db } = makeMockDb({ data: rows, error: null })
    const result = await listRecentPriceHistories(db, [])
    expect(result).toHaveLength(1)
  })

  it('エラー時は例外を投げる', async () => {
    const { db } = makeMockDb({ data: null, error: { message: 'query failed' } })
    await expect(listRecentPriceHistories(db, ['f1'])).rejects.toThrow('query failed')
  })
})
