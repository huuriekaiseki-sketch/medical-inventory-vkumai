import { supabase } from '@/lib/supabase/server'
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

export async function getPriceHistory(distributorProductId: string): Promise<PriceHistory[]> {
  const { data, error } = await supabase.rpc(
    'get_distributor_product_price_history',
    { p_distributor_product_id: distributorProductId }
  )
  if (error) throw new Error(error.message)
  return ((data as PriceHistoryRow[] | null) ?? []).map(mapPriceHistory)
}
