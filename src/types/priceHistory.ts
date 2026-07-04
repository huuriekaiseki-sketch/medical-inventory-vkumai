export type PriceHistoryEntityType = 'distributor_product' | 'hospital_price'

export type PriceHistoryFieldName =
  | 'reimbursement_price'
  | 'purchase_price'
  | 'delivery_price'

export interface PriceHistory {
  id: string
  entityType: PriceHistoryEntityType
  entityId: string
  distributorProductId: string
  fieldName: PriceHistoryFieldName
  oldValue: number | null
  newValue: number | null
  changedAt: string
  facilityName?: string | null
  // WHY: ダッシュボードの「全体横断の最近の価格改定」表示で商品名を出すために追加。
  //      既存の単一商品向け価格履歴（get_distributor_product_price_history）は
  //      呼び出し元が商品名を別途保持しているため未使用（optionalのまま後方互換）。
  productName?: string | null
}

export const FIELD_LABEL: Record<PriceHistoryFieldName, string> = {
  reimbursement_price: '償還価格',
  purchase_price: '仕入価格',
  delivery_price: '配送価格',
}

export const ENTITY_LABEL: Record<PriceHistoryEntityType, string> = {
  distributor_product: '償還価格',
  hospital_price: '施設価格',
}
