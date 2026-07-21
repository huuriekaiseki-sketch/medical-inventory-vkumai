import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { listDistributorProducts, createDistributorProduct } from '@/lib/distributor-products/repository'
import { apiError, sanitizeDbError } from '@/lib/api-error'
import { parseKeyword } from '@/lib/api-keyword-query'
import type {
  DistributorProductInput,
  DistributorProductsApiErrorResponse,
  DistributorProductsApiQuery,
  DistributorProductsApiResponse,
} from '@/types/distributorProduct'

// WHY: categoryId は UUID v4 形式のみ受け付ける（不正値は事前に400で弾き、DB往復を避ける）
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// WHY: apiError は共通の { error: string } 形式を返すが、DistributorProductsApiErrorResponse型と
//      一致していることをコンパイル時に保証するため、戻り値をこの型でラップして返す
//      （order.tsの参照実装パターンを踏襲。レビュー指摘: 型安全 — Set Bで新設した
//      ApiQuery/ApiErrorResponse型が未使用のdead typeだった）
function distributorProductsApiError(message: string, status = 500): NextResponse<DistributorProductsApiErrorResponse> {
  return apiError(message, status)
}

export async function GET(
  request: NextRequest
): Promise<NextResponse<DistributorProductsApiResponse> | NextResponse<DistributorProductsApiErrorResponse>> {
  try {
    const db = await createServerSupabase()
    try { await requireAuth(db) } catch { return distributorProductsApiError('認証が必要です', 401) }

    const params = request.nextUrl.searchParams
    const kw = parseKeyword(params)
    if (!kw.ok) return kw.response

    const rawCategoryId = params.get('categoryId') ?? ''
    if (rawCategoryId && !UUID_V4_RE.test(rawCategoryId)) {
      return distributorProductsApiError('categoryId は UUID 形式で指定してください', 400)
    }
    const categoryId = rawCategoryId || undefined

    // WHY: DistributorProductsApiQuery型（src/types/distributorProduct.ts）を実際に参照することで、
    //      route側のパース結果がSPECで定義した契約と一致していることをコンパイル時に保証する
    const query: DistributorProductsApiQuery = { keyword: kw.keyword, categoryId }

    const items = await listDistributorProducts(db, query)
    return NextResponse.json({ items } satisfies DistributorProductsApiResponse)
  } catch (error) {
    return distributorProductsApiError(sanitizeDbError(error, '販売店商品の取得に失敗しました'))
  }
}

export async function POST(request: NextRequest) {
  let input: DistributorProductInput
  try {
    input = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }

  if (!input.productId || !input.maker || !input.supplier || !input.name || !input.categoryId) {
    return apiError('必須項目が未入力です', 400)
  }

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const isAdmin = await resolveIsAdmin(db, user)
    if (!isAdmin) return apiError('権限がありません', 403)
    const item = await createDistributorProduct(db, input)
    return NextResponse.json({ item }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return apiError(error.message, 404)
    }
    return apiError(error instanceof Error ? error.message : 'ディーラー商品の作成に失敗しました')
  }
}
