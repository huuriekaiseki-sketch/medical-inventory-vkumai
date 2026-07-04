import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asNullableString, asNullableNumber } from '@/lib/mapping'
import type { PriceHistory, PriceHistoryEntityType, PriceHistoryFieldName } from '@/types/priceHistory'

interface PriceHistoryRow {
  id?: unknown
  entity_type?: unknown
  entity_id?: unknown
  dist_product_id?: unknown
  field_name?: unknown
  old_value?: unknown
  new_value?: unknown
  changed_at?: unknown
  facility_name?: unknown
}

interface RecentPriceHistoryRow {
  id?: unknown
  entity_type?: unknown
  entity_id?: unknown
  distributor_product_id?: unknown
  field_name?: unknown
  old_value?: unknown
  new_value?: unknown
  changed_at?: unknown
  distributor_products?: { name?: unknown } | null
}

/**
 * RPC行をPriceHistory型にマッピングする
 * DBカラム名（snake_case）をTypeScript型（camelCase）に変換
 * 特に dist_product_id を distributorProductId にマップ
 */
export function mapPriceHistory(row: PriceHistoryRow): PriceHistory {
  return {
    id: asString(row.id),
    entityType: asString(row.entity_type) as PriceHistoryEntityType,
    entityId: asString(row.entity_id),
    distributorProductId: asString(row.dist_product_id),
    fieldName: asString(row.field_name) as PriceHistoryFieldName,
    oldValue: asNullableNumber(row.old_value),
    newValue: asNullableNumber(row.new_value),
    changedAt: asString(row.changed_at),
    facilityName: asNullableString(row.facility_name),
  }
}

export async function getPriceHistory(db: SupabaseClient, distributorProductId: string): Promise<PriceHistory[]> {
  const { data, error } = await db.rpc(
    'get_distributor_product_price_history',
    { p_distributor_product_id: distributorProductId }
  )
  if (error) throw new Error(error.message)
  return ((data as PriceHistoryRow[] | null) ?? []).map(mapPriceHistory)
}

/**
 * RPC行（全体横断クエリ用）を PriceHistory 型にマッピングする
 * distributor_products を JOIN し productName を埋める（ダッシュボード表示用）
 * facilityName はこのクエリでは取得しないため常に null（既存の単一商品ページ側で別途利用）
 */
export function mapRecentPriceHistory(row: RecentPriceHistoryRow): PriceHistory {
  return {
    id: asString(row.id),
    entityType: asString(row.entity_type) as PriceHistoryEntityType,
    entityId: asString(row.entity_id),
    distributorProductId: asString(row.distributor_product_id),
    fieldName: asString(row.field_name) as PriceHistoryFieldName,
    oldValue: asNullableNumber(row.old_value),
    newValue: asNullableNumber(row.new_value),
    changedAt: asString(row.changed_at),
    facilityName: null,
    productName: asNullableString(row.distributor_products?.name),
  }
}

/**
 * 全体横断の最近の価格改定を changed_at 降順で最大 limit 件取得する
 * Set 4: ダッシュボードの「最近の価格改定」セクション向け
 */
export async function listRecentPriceHistories(db: SupabaseClient, limit = 10): Promise<PriceHistory[]> {
  const { data, error } = await db
    .from('price_histories')
    .select('id, entity_type, entity_id, distributor_product_id, field_name, old_value, new_value, changed_at, distributor_products(name)')
    .order('changed_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return ((data ?? []) as unknown as RecentPriceHistoryRow[]).map(mapRecentPriceHistory)
}
