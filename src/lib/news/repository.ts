import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asNullableString, asNullableNumber, asEnum } from '@/lib/mapping'
import type { NewsFeedItem, NewsFeedEventType } from '@/types/newsFeedItem'
import type { PriceHistoryFieldName } from '@/types/priceHistory'

const EVENT_TYPES = [
  'distributor_price_change',
  'hospital_price_change',
  'new_product',
] as const satisfies readonly NewsFeedEventType[]

const FIELD_NAMES = [
  'reimbursement_price',
  'purchase_price',
  'delivery_price',
] as const satisfies readonly PriceHistoryFieldName[]

interface NewsFeedRow {
  id?: unknown
  event_type?: unknown
  occurred_at?: unknown
  distributor_product_id?: unknown
  product_name?: unknown
  maker?: unknown
  supplier?: unknown
  field_name?: unknown
  old_value?: unknown
  new_value?: unknown
  facility_name?: unknown
}

export function mapNewsFeedItem(row: NewsFeedRow): NewsFeedItem {
  return {
    id: asString(row.id),
    eventType: asEnum(row.event_type, EVENT_TYPES, 'distributor_price_change'),
    occurredAt: asString(row.occurred_at),
    distributorProductId: asString(row.distributor_product_id),
    productName: asString(row.product_name),
    maker: asString(row.maker),
    supplier: asString(row.supplier),
    fieldName:
      row.field_name === null || row.field_name === undefined
        ? null
        : asEnum(row.field_name, FIELD_NAMES, 'reimbursement_price'),
    oldValue: asNullableNumber(row.old_value),
    newValue: asNullableNumber(row.new_value),
    facilityName: asNullableString(row.facility_name),
  }
}

export async function listNewsFeed(
  db: SupabaseClient,
  { facilityId, limit = 20, offset = 0 }: { facilityId: string | null; limit?: number; offset?: number }
): Promise<NewsFeedItem[]> {
  const { data, error } = await db.rpc('get_news_feed', {
    p_facility_id: facilityId,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) throw new Error(error.message)
  return ((data as NewsFeedRow[] | null) ?? []).map(mapNewsFeedItem)
}
