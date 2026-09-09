import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { parseQuery } from '@/lib/validation/parse-query'
import { keywordQueryShape } from '@/lib/api-keyword-query'

const productsQuerySchema = z.object({ ...keywordQueryShape() })
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { listProducts, createProduct } from '@/lib/products/repository'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import type { ProductsApiErrorResponse, ProductsApiQuery, ProductsApiResponse } from '@/types/product'
import { parseBody } from '@/lib/validation/parse-body'
import { productInputSchema } from '@/lib/validation/schemas'

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
    try { await requireAuth(db) } catch (e) { return authGuardError(e) }

    // WHY(2026-09-09): クエリを読むのは parseQuery だけ（keyword の判定は keywordQueryShape）
    const parsed = parseQuery(request, productsQuerySchema)
    if (!parsed.ok) return parsed.response

    // WHY: ProductsApiQuery型（src/types/product.ts）を実際に参照することで、route側の
    //      パース結果がSPECで定義した契約と一致していることをコンパイル時に保証する
    const query: ProductsApiQuery = { ...(parsed.data.keyword ? { keyword: parsed.data.keyword } : {}) }

    const products = await listProducts(db, query)
    return NextResponse.json({ products } satisfies ProductsApiResponse)
  } catch (error) {
    return productsApiError(toClientErrorMessage(error, '製品の取得に失敗しました'))
  }
}

export async function POST(request: NextRequest) {
  const parsed = await parseBody(request, productInputSchema)
  if (!parsed.ok) return parsed.response
  const input = { ...parsed.data, maker: parsed.data.maker ?? null }

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
    const isAdmin = await resolveIsAdmin(db, user)
    if (!isAdmin) return apiError('権限がありません', 403)
    const product = await createProduct(db, input)
    return NextResponse.json({ product }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return apiError('JAN または REF が重複しています', 409)
    }
    return apiError(toClientErrorMessage(error, '製品の作成に失敗しました'))
  }
}
