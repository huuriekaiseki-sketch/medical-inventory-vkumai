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
  /** 発注時点の単価スナップショット。既存データ(unit_price追加前)はnull */
  unitPrice: number | null
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

/**
 * GET /api/consumables のレスポンス型（成功時）
 * Issue #647 Set A: 消耗品登録UIが一覧再取得に使う
 */
export type ConsumablesApiGetResponse = {
  consumables: Consumable[]
}

/**
 * POST /api/consumables のリクエストボディ型
 * Issue #647 Set A: ConsumableRegisterForm.tsx が送信するペイロード
 * facilityId は必須。name/purpose は空白のみの場合route側で400になる
 */
export type ConsumablesApiPostRequest = ConsumableInput & {
  facilityId: string
}

/**
 * POST /api/consumables のレスポンス型（成功時、201）
 * Issue #647 Set A
 */
export type ConsumablesApiPostResponse = {
  consumable: Consumable
}

/**
 * /api/consumables (GET/POST共通) のエラーレスポンス型
 * 400: facilityId/name/purpose 不正, 401: 未認証, 403: 他施設アクセス, 500: サーバーエラー
 */
export type ConsumablesApiErrorResponse = {
  error: string
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
  /** 発注時点の単価スナップショット。既存データ(unit_price追加前)はnull */
  unitPrice: number | null
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
  /** 発注時点の単価スナップショット。既存データ(unit_price追加前)はnull */
  unitPrice: number | null
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
  /** Set A で追加した loan_order_id FK に対応。既存行は追跡不能のため任意 */
  loanOrderId?: string
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

/**
 * 発注種別識別子（issue #20 発注履歴ページ）
 * Set B: 横断一覧・APIの kind パラメータ・タブUIで共通利用
 */
export type OrderKind = 'case_order' | 'consumable_order' | 'loan_order' | 'loan_return'

/**
 * 横断一覧用サマリ型（issue #20 発注履歴ページ）
 * Set C: listOrders(db, facilityId, filter, limit, offset) の戻り値要素
 * unreturned は kind === 'loan_order' かつ status === 'submitted' かつ
 * 対応する loan_returns が0件の場合のみ true。それ以外は false または undefined
 */
export type OrderListItem = {
  id: string
  kind: OrderKind
  facilityId: string
  /** 各種別のステータス値をそのまま文字列で保持（draft/submitted/returned） */
  status: string
  /** 手技名 / 消耗品 N 品目 など、UI 表示用の概要テキスト */
  summary: string
  createdAt: string
  /** loan_order のみ意味を持つ。true: 対応する返却記録が0件 */
  unreturned?: boolean
}

/**
 * 横断一覧の絞り込み条件（issue #20 発注履歴ページ）
 * Set C: listOrders の filter 引数 / Set D: /api/orders クエリパラメータの由来
 * dateFrom/dateTo は YYYY-MM-DD（JST日境界の解釈は repository 側の責務）
 */
export type OrderListFilter = {
  kind?: OrderKind
  dateFrom?: string
  dateTo?: string
  keyword?: string
}

/**
 * GET /api/orders のクエリパラメータ（パース・バリデーション後の型）
 * Set D: limit は 1〜200、offset は 0 以上の整数であることをroute側で検証済みとする
 */
export type OrdersApiQuery = OrderListFilter & {
  facilityId: string
  limit: number
  offset: number
}

/**
 * GET /api/orders のレスポンス型（成功時）
 * Set D: route.ts が返すペイロード
 */
export type OrdersApiResponse = {
  orders: OrderListItem[]
}

/**
 * GET /api/orders のエラーレスポンス型
 * 400: facility_id 未指定・limit/offset/kind 不正, 401: 未認証, 403: 他施設アクセス, 500: サーバーエラー
 */
export type OrdersApiErrorResponse = {
  error: string
}
