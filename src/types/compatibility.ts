import type { Product } from '@/types/product'

// WHY: 一覧・詳細表示用にカテゴリ名・製品名/JAN/メーカーをJOIN済みの形で保持する。
// APIレスポンスをそのままUIコンポーネントのpropsに渡せるようにするため。
export type ProductCompatibility = {
  id: string
  categoryId: string
  categoryName: string
  productId1: string
  product1: { jan: string; name: string; maker: string | null }
  productId2: string
  product2: { jan: string; name: string; maker: string | null }
  note: string | null
  createdAt: string
  updatedAt: string
}

// WHY: 登録フォーム送信・repository層への入力を表す型。
// productId1/productId2 の順序はAPI/リポジトリ層で正規化されるため、
// この型自体は入力順（フォームの製品A/B）をそのまま表現する。
export type ProductCompatibilityInput = {
  categoryId: string
  productId1: string
  productId2: string
  note: string | null
}

// ---- API: GET/POST /api/compat ----

// WHY: クエリパラメータはURLSearchParams由来のstringのみを扱うため、
// undefinedは「未指定」を表す（空文字は呼び出し側でundefined扱いにする）。
export type ListCompatibilitiesQuery = {
  categoryId?: string
  keyword?: string
}

export type ListCompatibilitiesResponse = {
  compatibilities: ProductCompatibility[]
}

export type CreateCompatibilityResponse = {
  compatibility: ProductCompatibility
}

// ---- API: DELETE /api/compat/[id] ----

export type DeleteCompatibilityResponse = {
  success: true
}

// ---- API: GET /api/compat/products ----

// WHY: このエンドポイントはフォームの製品候補取得専用であり、categoryIdは必須。
export type ListProductsInCategoryQuery = {
  categoryId: string
}

export type ListProductsInCategoryResponse = {
  products: Product[]
}
