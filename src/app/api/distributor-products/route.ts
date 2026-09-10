import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { parseQuery } from '@/lib/validation/parse-query'
import { optionalUuidQuery } from '@/lib/validation/uuid'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { listDistributorProducts, createDistributorProduct } from '@/lib/distributor-products/repository'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import { ClientVisibleError } from '@/lib/client-visible-error'
import { keywordQueryShape } from '@/lib/api-keyword-query'
import { parseBody } from '@/lib/validation/parse-body'
import { distributorProductInputSchema } from '@/lib/validation/schemas'
import type {
  DistributorProductsApiErrorResponse,
  DistributorProductsApiQuery,
  DistributorProductsApiResponse,
} from '@/types/distributorProduct'

// WHY: categoryId は UUID v4 形式のみ受け付ける（不正値は事前に400で弾き、DB往復を避ける）
// WHY(2026-09-09、版 4 限定をやめた): ここだけ `UUID_V4_RE`（版 4 限定）で、ほかの 5 か所は版を見なかった。
//      版まで縛るのは 2026-09-07 に否定した判断（PostgreSQL の uuid 型はどの版でも受けるので、
//      DB が受ける正当な ID を入口で弾いてしまう）。判定は validation/uuid.ts に 1 つだけ。
//      いま踏めるかというと踏めない（この製品の ID は gen_random_uuid() = 版 4）が、
//      **同じ問いに 2 通りの答えがある状態**そのものを消す（E-053）
const distributorProductsQuerySchema = z.object({
  categoryId: optionalUuidQuery('categoryId は UUID 形式で指定してください'),
  ...keywordQueryShape(),
})

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
    try { await requireAuth(db) } catch (e) { return authGuardError(e) }

    const parsed = parseQuery(request, distributorProductsQuerySchema)
    if (!parsed.ok) return parsed.response
    const { categoryId, keyword } = parsed.data

    // WHY: DistributorProductsApiQuery型（src/types/distributorProduct.ts）を実際に参照することで、
    //      route側のパース結果がSPECで定義した契約と一致していることをコンパイル時に保証する
    const query: DistributorProductsApiQuery = { keyword, categoryId }

    const items = await listDistributorProducts(db, query)
    return NextResponse.json({ items } satisfies DistributorProductsApiResponse)
  } catch (error) {
    return distributorProductsApiError(toClientErrorMessage(error, '販売店商品の取得に失敗しました'))
  }
}

export async function POST(request: NextRequest) {
  const parsed = await parseBody(request, distributorProductInputSchema)
  if (!parsed.ok) return parsed.response
  const input = parsed.data

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
    const isAdmin = await resolveIsAdmin(db, user)
    if (!isAdmin) return apiError('権限がありません', 403)
    const item = await createDistributorProduct(db, input)
    return NextResponse.json({ item }, { status: 201 })
  } catch (error) {
    // WHY(2026-09-11): `Error` ではなく `ClientVisibleError` を見る（理由は
    //      hospital-prices/route.ts と同じ。ここも error.message をそのまま返すため）。
    if (error instanceof ClientVisibleError && error.message.includes('存在しません')) {
      return apiError(error.message, 404)
    }
    return apiError(toClientErrorMessage(error, 'ディーラー商品の作成に失敗しました'))
  }
}
