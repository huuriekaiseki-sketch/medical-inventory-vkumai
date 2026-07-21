import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { listProducts, createProduct } from '@/lib/products/repository'
import { apiError, sanitizeDbError } from '@/lib/api-error'
import { parseKeyword } from '@/lib/api-keyword-query'
import type { ProductInput, ProductsApiErrorResponse, ProductsApiQuery, ProductsApiResponse } from '@/types/product'

// WHY: apiError は共通の { error: string } 形式を返すが、ProductsApiErrorResponse型と一致していることを
//      コンパイル時に保証するため、戻り値をこの型でラップして返す（order.tsの参照実装パターンを踏襲。
//      レビュー指摘: 型安全 — Set Bで新設したApiQuery/ApiErrorResponse型が未使用のdead typeだった）
function productsApiError(message: string, status = 500): NextResponse<ProductsApiErrorResponse> {
  return apiError(message, status)
}

export async function GET(
  request: NextRequest
): Promise<NextResponse<ProductsApiResponse> | NextResponse<ProductsApiErrorResponse>> {
  try {
    const db = await createServerSupabase()
    try { await requireAuth(db) } catch { return productsApiError('認証が必要です', 401) }

    const kw = parseKeyword(request.nextUrl.searchParams)
    if (!kw.ok) return kw.response

    // WHY: ProductsApiQuery型（src/types/product.ts）を実際に参照することで、route側の
    //      パース結果がSPECで定義した契約と一致していることをコンパイル時に保証する
    const query: ProductsApiQuery = { ...(kw.keyword ? { keyword: kw.keyword } : {}) }

    const products = await listProducts(db, query)
    return NextResponse.json({ products } satisfies ProductsApiResponse)
  } catch (error) {
    return productsApiError(sanitizeDbError(error, '製品の取得に失敗しました'))
  }
}

export async function POST(request: NextRequest) {
  let input: ProductInput
  try {
    input = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }

  if (!input.jan || !input.ref) {
    return apiError('JAN と REF は必須です', 400)
  }

  if (!input.name || !input.name.trim()) {
    return apiError('製品名は必須です', 400)
  }

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const isAdmin = await resolveIsAdmin(db, user)
    if (!isAdmin) return apiError('権限がありません', 403)
    const product = await createProduct(db, input)
    return NextResponse.json({ product }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return apiError('JAN または REF が重複しています', 409)
    }
    return apiError(error instanceof Error ? error.message : '製品の作成に失敗しました')
  }
}
