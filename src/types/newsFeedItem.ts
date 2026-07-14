import type { PriceHistoryFieldName } from './priceHistory'

export type NewsFeedEventType =
  | 'distributor_price_change'
  | 'hospital_price_change'
  | 'new_product'

export type NewsFeedItem = {
  id: string
  eventType: NewsFeedEventType
  occurredAt: string
  distributorProductId: string
  productName: string
  maker: string
  supplier: string
  fieldName: PriceHistoryFieldName | null
  oldValue: number | null
  newValue: number | null
  facilityName: string | null
}

export const EVENT_TYPE_LABEL: Record<NewsFeedEventType, string> = {
  distributor_price_change: '価格改定（償還価格）',
  hospital_price_change: '価格改定（施設価格）',
  new_product: '新製品登録',
}
