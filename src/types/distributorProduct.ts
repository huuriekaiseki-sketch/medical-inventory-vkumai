export type DistributorProduct = {
  id: string
  productId: string
  maker: string
  supplier: string
  name: string
  reimbursementPrice: number | null
  quantity: number
  categoryId: string
  createdAt: string
  updatedAt: string
}

export type DistributorProductInput = {
  productId: string
  maker: string
  supplier: string
  name: string
  reimbursementPrice: number | null
  quantity: number
  categoryId: string
}

/**
 * listDistributorProducts（src/lib/distributor-products/repository.ts）の絞り込み条件
 * SPEC: /products・/distributor-products への検索・絞り込みUI追加（issue #483）Set C
 */
export type DistributorProductListFilter = { keyword?: string; categoryId?: string }

/**
 * GET /api/distributor-products のクエリパラメータ（パース・バリデーション後の型）
 * SPEC: /products・/distributor-products への検索・絞り込みUI追加（issue #483）Set D
 * keyword は parseKeyword（src/lib/api-keyword-query.ts）でトリム・長さ検証済み。
 * categoryId は UUID v4 形式検証済み（不正値はroute側で400を返し、この型には到達しない）。
 * どちらも空文字列・未指定は undefined として扱う
 * WHY: ApiQueryとFilterを別々に定義すると、フィールド追加時に型ドリフトをコンパイラが検出できない
 *      （レビュー指摘: 型安全 — order.tsのOrdersApiQuery = OrderListFilter & {...}パターンに反する）。
 *      現時点ではrouteに固有の追加フィールドが無いため、DistributorProductListFilterをそのまま別名として使う
 */
export type DistributorProductsApiQuery = DistributorProductListFilter

/**
 * GET /api/distributor-products のレスポンス型（成功時）
 * 既存クライアントとの互換性維持のためキー名は items のまま統一しない
 */
export type DistributorProductsApiResponse = { items: DistributorProduct[] }

/**
 * GET /api/distributor-products のエラーレスポンス型
 * 400: keyword 長さ超過 / categoryId 形式不正, 401: 未認証, 500: サーバーエラー（sanitizeDbError経由）
 */
export type DistributorProductsApiErrorResponse = { error: string }
