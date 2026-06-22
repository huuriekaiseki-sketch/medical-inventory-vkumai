import { supabase } from '@/lib/supabase/server'
import type { PriceHistory, PriceHistoryEntityType, PriceHistoryFieldName } from '@/types/priceHistory'

/**
 * RPC行をPriceHistory型にマッピングする
 * DBカラム名（snake_case）をTypeScript型（camelCase）に変換
 * 特に dist_product_id を distributorProductId にマップ
 */
export function mapPriceHistory(row: Record<string, unknown>): PriceHistory {
  return {
    id: row.id as string,
    entityType: row.entity_type as PriceHistoryEntityType,
    entityId: row.entity_id as string,
    distributorProductId: row.dist_product_id as string,
    fieldName: row.field_name as PriceHistoryFieldName,
    oldValue: row.old_value != null ? Number(row.old_value) : null,
    newValue: row.new_value != null ? Number(row.new_value) : null,
    changedAt: row.changed_at as string,
    facilityName: (row.facility_name as string | null) ?? null,
  }
}

export async function getPriceHistory(distributorProductId: string): Promise<PriceHistory[]> {
  const { data, error } = await supabase.rpc(
    'get_distributor_product_price_history',
    { p_distributor_product_id: distributorProductId }
  )
  if (error) throw new Error(error.message)
  return (data as Record<string, unknown>[] | null ?? []).map(mapPriceHistory)
}
