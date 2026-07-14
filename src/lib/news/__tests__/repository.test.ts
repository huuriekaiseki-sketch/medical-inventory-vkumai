import { describe, it, expect, vi } from 'vitest'
import { listNewsFeed, mapNewsFeedItem } from '../repository'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeMockDb(rpcResult: unknown) {
  const rpcFn = vi.fn().mockResolvedValueOnce(rpcResult)
  const db = { rpc: rpcFn } as unknown as SupabaseClient
  return { db, rpcFn }
}

describe('mapNewsFeedItem', () => {
  it('価格改定行を正しくマッピングする', () => {
    const row = {
      id: 'ph-1',
      event_type: 'hospital_price_change',
      occurred_at: '2026-07-08T01:00:00Z',
      distributor_product_id: 'dp-1',
      product_name: '商品A',
      maker: 'メーカーA',
      supplier: '仕入先A',
      field_name: 'purchase_price',
      old_value: 100,
      new_value: 120,
      facility_name: '施設A',
    }
    expect(mapNewsFeedItem(row)).toEqual({
      id: 'ph-1',
      eventType: 'hospital_price_change',
      occurredAt: '2026-07-08T01:00:00Z',
      distributorProductId: 'dp-1',
      productName: '商品A',
      maker: 'メーカーA',
      supplier: '仕入先A',
      fieldName: 'purchase_price',
      oldValue: 100,
      newValue: 120,
      facilityName: '施設A',
    })
  })

  it('新製品登録行はfieldName/oldValue/newValue/facilityNameがnullになる', () => {
    const row = {
      id: 'new_product_dp-2',
      event_type: 'new_product',
      occurred_at: '2026-07-08T02:00:00Z',
      distributor_product_id: 'dp-2',
      product_name: '商品B',
      maker: 'メーカーB',
      supplier: '仕入先B',
      field_name: null,
      old_value: null,
      new_value: null,
      facility_name: null,
    }
    const result = mapNewsFeedItem(row)
    expect(result.eventType).toBe('new_product')
    expect(result.fieldName).toBeNull()
    expect(result.oldValue).toBeNull()
    expect(result.facilityName).toBeNull()
  })

  it('不正なevent_typeはdistributor_price_changeにフォールバックする', () => {
    const row = { id: 'x', event_type: 'unknown', occurred_at: '2026-07-08T00:00:00Z' }
    expect(mapNewsFeedItem(row).eventType).toBe('distributor_price_change')
  })
})

describe('listNewsFeed', () => {
  it('facilityId/limit/offsetをRPCに渡す', async () => {
    const { db, rpcFn } = makeMockDb({ data: [], error: null })
    await listNewsFeed(db, { facilityId: 'f1', limit: 20, offset: 0 })
    expect(rpcFn).toHaveBeenCalledWith('get_news_feed', {
      p_facility_id: 'f1',
      p_limit: 20,
      p_offset: 0,
    })
  })

  it('facilityIdがnullでも呼び出せる', async () => {
    const { db, rpcFn } = makeMockDb({ data: [], error: null })
    await listNewsFeed(db, { facilityId: null, limit: 20, offset: 0 })
    expect(rpcFn).toHaveBeenCalledWith('get_news_feed', {
      p_facility_id: null,
      p_limit: 20,
      p_offset: 0,
    })
  })

  it('limit/offset省略時はデフォルト値(20, 0)を使う', async () => {
    const { db, rpcFn } = makeMockDb({ data: [], error: null })
    await listNewsFeed(db, { facilityId: 'f1' })
    expect(rpcFn).toHaveBeenCalledWith('get_news_feed', {
      p_facility_id: 'f1',
      p_limit: 20,
      p_offset: 0,
    })
  })

  it('RPCエラー時は例外を投げる', async () => {
    const { db } = makeMockDb({ data: null, error: { message: 'boom' } })
    await expect(listNewsFeed(db, { facilityId: 'f1' })).rejects.toThrow('boom')
  })

  it('0件の場合は空配列を返す', async () => {
    const { db } = makeMockDb({ data: [], error: null })
    const result = await listNewsFeed(db, { facilityId: 'f1' })
    expect(result).toEqual([])
  })
})
