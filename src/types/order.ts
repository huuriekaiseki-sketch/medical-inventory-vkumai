export type CaseOrder = {
  id: string
  facilityId: string
  caseDatetime: string
  procedureName: string
  patientId: string
  patientInitials: string
  gender: 'male' | 'female' | 'other'
  doctorName: string
  status: 'draft' | 'submitted'
  items: CaseOrderItem[]
  createdAt: string
  updatedAt: string
}

export type CaseOrderItem = {
  id: string
  caseOrderId: string
  jan: string
  lot?: string
  ubd?: string
  quantity: number
  createdAt: string
}

export type CaseOrderInput = {
  caseDatetime: string
  procedureName: string
  patientId: string
  patientInitials: string
  gender: 'male' | 'female' | 'other'
  doctorName: string
  items: CaseOrderItemInput[]
}

export type CaseOrderItemInput = {
  jan: string
  lot?: string
  ubd?: string
  quantity: number
}

export type Consumable = {
  id: string
  facilityId: string
  name: string
  jan?: string
  purpose: string
  createdAt: string
  updatedAt: string
}

export type ConsumableInput = {
  name: string
  jan?: string
  purpose: string
}

export type ConsumableOrder = {
  id: string
  facilityId: string
  status: 'draft' | 'submitted'
  items: ConsumableOrderItem[]
  createdAt: string
  updatedAt: string
}

export type ConsumableOrderItem = {
  id: string
  consumableOrderId: string
  consumableId: string
  quantity: number
  createdAt: string
}

export type ConsumableOrderInput = {
  items: ConsumableOrderItemInput[]
}

export type ConsumableOrderItemInput = {
  consumableId: string
  quantity: number
}

export type LoanOrder = {
  id: string
  facilityId: string
  procedureName: string
  maker: string
  status: 'draft' | 'submitted'
  items: LoanOrderItem[]
  createdAt: string
  updatedAt: string
}

export type LoanOrderItem = {
  id: string
  loanOrderId: string
  jan?: string
  name: string
  quantity: number
  createdAt: string
}

export type LoanOrderInput = {
  procedureName: string
  maker: string
  items: LoanOrderItemInput[]
}

export type LoanOrderItemInput = {
  jan?: string
  name: string
  quantity: number
}

export type LoanReturn = {
  id: string
  facilityId: string
  returnDatetime: string
  status: 'draft' | 'returned'
  items: LoanReturnItem[]
  createdAt: string
  updatedAt: string
}

export type LoanReturnItem = {
  id: string
  loanReturnId: string
  jan: string
  lot?: string
  ubd?: string
  quantity: number
  createdAt: string
}

export type LoanReturnInput = {
  returnDatetime: string
  items: LoanReturnItemInput[]
}

export type LoanReturnItemInput = {
  jan: string
  lot?: string
  ubd?: string
  quantity: number
}

// ---------------------------------------------------------------------------
// issue #20: 発注履歴ページ（/orders）— 4種別横断の一覧・検索
// ---------------------------------------------------------------------------

/**
 * 発注種別の判別キー
 * case: 症例発注 / consumable: 消耗品発注 / loan: 短貸発注 / loan_return: 短貸返却
 */
export type OrderKind = 'case' | 'consumable' | 'loan' | 'loan_return'

/**
 * 4種別を横断表示するための正規化済み1レコード
 * SET-D（/api/orders）が生成し、SET-E（OrderHistoryTable等）が描画に使う
 * raw原案は削除済み（union型のtype guardが強制されず実行時エラーリスクがあるため）。
 * 詳細遷移は id + kind のみで既存個別ページ（例: /loan-orders/{id}）へのリンクで完結する
 * v1では isUnreturned 等の「未返却」判定フィールドを含めない（判断が必要な点①、案B未採用のため）
 */
export type UnifiedOrder = {
  id: string
  kind: OrderKind
  facilityId: string
  facilityName?: string // admin表示用（施設JOIN先から解決。非adminには不要なため省略可）
  displayDatetime: string // case→case_datetime / consumable・loan→created_at / loan_return→return_datetime。生成責任はAPI層(SET-D)
  status: string // 各テーブルの生status文字列をそのまま保持（判定ロジックはSET-Dに置かない）
  summaryLabel: string // 代表製品名 + 残n件。生成責任はAPI層(SET-D)
}

/**
 * /orders ページ・/api/orders が共有するフィルタ条件
 * SET-F（ページ）がURLクエリから組み立て、SET-D（API）がクエリパラメータとして受け取る
 */
export type OrdersFilter = {
  facilityId?: string
  dateFrom?: string // ISO 8601 (UTC)
  dateTo?: string // ISO 8601 (UTC)
  productSearch?: string
  orderKinds?: OrderKind[]
}

/**
 * SET-C: 4種別の list*（listCaseOrders / listConsumableOrders / listLoanOrders / listLoanReturns）
 * に追加する日付・製品名フィルタのオプション引数。既存の limit/offset 引数の後ろに追加する想定
 * dateFrom/dateTo: ISO 8601 UTC文字列。省略時はその境界のフィルタを適用しない
 * productSearch: 品名部分一致（ilike）。空文字/省略はフィルタを適用しない（受け入れ条件・SET-C記載どおり）
 */
export type OrderListFilterOptions = {
  dateFrom?: string
  dateTo?: string
  productSearch?: string
}

/**
 * GET /api/orders が返す1件分の取得失敗理由
 * Promise.allSettled で失敗した種別のみ格納する。成功種別は errors に含めない
 */
export type OrdersFetchError = {
  kind: OrderKind
  message: string
}

/**
 * SET-D: src/lib/orders/unified-repository.ts の集約関数、および
 * GET /api/orders のレスポンス型（成功時、ステータス200）
 * orders は displayDatetime 降順・同時刻は id 昇順で安定ソート済みの状態で返す
 * counts フィールドは持たない（判断が必要な点⑥: 総件数表示は不要のため）
 */
export type OrdersGetResponse = {
  orders: UnifiedOrder[]
  errors: OrdersFetchError[]
}

/**
 * GET /api/orders のエラーレスポンス型（400/401/403/500）
 * apiError() が返す { error: string } 形式と一致させる
 */
export type OrdersErrorResponse = {
  error: string
}

/**
 * GET /api/orders のクエリパラメータをパース済みの形で表す型
 * order_kinds は CSV文字列として受け取り、API層（SET-D）で OrderKind[] にバリデーション・変換する。
 * 不正な値（未知のkind文字列等）が含まれる場合の扱いはSET-D実装側の責務とする
 */
export type OrdersQueryParams = {
  facilityId: string | null
  dateFrom: string | null
  dateTo: string | null
  productSearch: string | null
  orderKinds: OrderKind[] | null
}
