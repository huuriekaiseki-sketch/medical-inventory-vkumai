export type Product = {
  id: string
  jan: string
  ref: string
  name: string
  maker: string | null
  createdAt: string
  updatedAt: string
}

export type ProductInput = {
  jan: string
  ref: string
  name: string
  maker?: string | null
}

/**
 * listProducts（src/lib/products/repository.ts）の絞り込み条件
 * SPEC: /products・/distributor-products への検索・絞り込みUI追加（issue #483）Set C
 */
export type ProductListFilter = { keyword?: string }

/**
 * GET /api/products のクエリパラメータ（パース・バリデーション後の型）
 * SPEC: /products・/distributor-products への検索・絞り込みUI追加（issue #483）Set D
 * keyword は parseKeyword（src/lib/api-keyword-query.ts）でトリム・長さ検証済み。
 * 空文字列・未指定は undefined として扱う
 * WHY: ApiQueryとFilterを別々に定義すると、フィールド追加時に型ドリフトをコンパイラが検出できない
 *      （レビュー指摘: 型安全 — order.tsのOrdersApiQuery = OrderListFilter & {...}パターンに反する）。
 *      現時点ではrouteに固有の追加フィールドが無いため、ProductListFilterをそのまま別名として使う
 */
export type ProductsApiQuery = ProductListFilter

/**
 * GET /api/products のレスポンス型（成功時）
 * 既存クライアントとの互換性維持のためキー名は products のまま統一しない
 */
export type ProductsApiResponse = { products: Product[] }

/**
 * GET /api/products のエラーレスポンス型
 * 400: keyword 長さ超過, 401: 未認証, 500: サーバーエラー（sanitizeDbError経由）
 */
export type ProductsApiErrorResponse = { error: string }
