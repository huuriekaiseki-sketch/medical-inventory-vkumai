export type CaseOrder = {
  id: string
  facilityId: string
  caseDatetime: string
  procedureName: string
  patientId: string
  patientInitials: string
  gender: 'male' | 'female' | 'other'
  doctorName: string
  /** cancelled は 2026-09-08 に足した取り消し状態（E-056）。行は消さず状態で表す */
  status: 'draft' | 'submitted' | 'cancelled'
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
  /** 二重送信対策の鍵（UUID）。画面がフォームを開いたときに 1 回だけ生成する。同じ鍵の再送は同じ発注を返す（P-053） */
  clientRequestId?: string
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
  /** retired は 2026-09-09 に足した使用停止（一覧と発注の選択肢から外れるが、過去の発注は残る） */
  status: 'active' | 'retired'
  /**
   * 発注で使われたことがあるか（2026-09-09）。
   * WHY(画面が押す前に知る必要がある): 使われていれば消せず、使用停止にするしかない。
   *      押してから 409 で気づかせるより、ボタンの出し分けで先に示す
   */
  inUse: boolean
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
  /** cancelled は 2026-09-08 に足した取り消し状態（E-056）。行は消さず状態で表す */
  status: 'draft' | 'submitted' | 'cancelled'
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
  /** 二重送信対策の鍵（UUID）。P-053 */
  clientRequestId?: string
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
  /** cancelled は 2026-09-08 に足した取り消し状態（E-056）。行は消さず状態で表す */
  status: 'draft' | 'submitted' | 'cancelled'
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
  /**
   * この明細に対して**もう返した**数量の合計（2026-09-08）。
   * 返却フォームが「残り」を出すために使う。紐付けの無い返却は入らない。
   */
  returnedQuantity?: number
}

export type LoanOrderInput = {
  procedureName: string
  maker: string
  items: LoanOrderItemInput[]
  /** 二重送信対策の鍵（UUID）。P-053 */
  clientRequestId?: string
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
  /**
   * `cancelled` は 2026-09-08 に足した取り消し状態（E-056）。
   * **行は消さない**（誰がいつ取り消したかを残す）。取り消した返却は
   * 残数・未返却の件数のどちらにも数えない。取り消しからは戻れない。
   */
  status: 'draft' | 'returned' | 'cancelled'
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
  /** どの発注明細に対する返却か。紐付けない返却では undefined（2026-09-08） */
  loanOrderItemId?: string
  /**
   * 品目ごとの取り消し（2026-09-09、E-056 の残り）。
   *
   * WHY: 1 回の返却で複数の品目を返したとき、そのうち 1 品目だけが間違いということが起きる。
   *      回ごと取り消して全部入れ直すのではなく、その品目だけを `cancelled` にする。
   *      `cancelled` の明細は残数・未返却の計算から除かれる（DB・アプリの 4 か所で同じ条件）。
   */
  status: 'active' | 'cancelled'
}

export type LoanReturnInput = {
  returnDatetime: string
  items: LoanReturnItemInput[]
  /** 二重送信対策の鍵（UUID）。P-053 */
  clientRequestId?: string
}

export type LoanReturnItemInput = {
  jan: string
  lot?: string
  ubd?: string
  quantity: number
  /**
   * どの発注明細に対する返却か（`loan_order_items.id`）。
   *
   * WHY(2026-09-08 追加): 分割返却を表せるようにした（20260908030000）。
   *      この紐付けが無い返却は残数の計算にも過剰返却の判定にも入らない
   *      （対象を選ばずに記録だけ残す従来の経路を塞がないため）。
   *      施設をまたいだ紐付けは RPC が弾く。
   */
  loanOrderItemId?: string
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
 * **まだ返っていない数量が残っている**場合のみ true（2026-09-08 に「返却が 0 件」から変えた。
 * 分割返却を表せるようにしたので、一部だけ返した発注も未返却のまま残る）
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
  /** loan_order のみ意味を持つ。true: まだ返っていない数量がある */
  unreturned?: boolean
  /**
   * loan_order のみ意味を持つ。まだ返っていない数量の合計。
   * 一覧のバッジが「未返却 2」のように出す（人が残りを知りたいため）。
   */
  outstandingQuantity?: number
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
