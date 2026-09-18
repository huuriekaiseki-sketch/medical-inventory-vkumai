import { NextRequest, NextResponse } from 'next/server'
import { keywordQueryShape } from '@/lib/api-keyword-query'
import { z } from 'zod'
import { parseQuery } from '@/lib/validation/parse-query'
import { dateRangeShape, refineDateRange } from '@/lib/jst-date-range'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listOrders } from '@/lib/orders/repository'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import { paginationQueryShape } from '@/lib/api-pagination'
import type { OrderKind, OrdersApiErrorResponse, OrdersApiQuery, OrdersApiResponse } from '@/types/order'

// WHY: apiError は共通の { error: string } 形式を返すが、OrdersApiErrorResponse型と一致していることを
//      コンパイル時に保証するため、戻り値をこの型でラップして返す
function ordersApiError(message: string, status = 500): NextResponse<OrdersApiErrorResponse> {
  return apiError(message, status)
}

const ORDER_KINDS: readonly OrderKind[] = ['case_order', 'consumable_order', 'loan_order', 'loan_return']

// WHY(2026-09-09、判定を共有へ): この route は日付の**形式だけ**を見て前後関係は見ておらず、
//      監査・レポート route（前後関係も見る）と条件が違っていた。`keyword` には長さの上限も無く、
//      同じ族の `/api/products`・`/api/distributor-products`（100 文字）と食い違っていた。
//      判定を共有へ寄せると、この route は**前後関係と keyword の上限を新しく得る**。
//
// WHY(facility_id は必須): 発注履歴は横断一覧なので、施設を指定しない全件横断は許さない
//      （admin であっても。移行前と同じ）。
const ordersQuerySchema = refineDateRange(
  z.object({
    facility_id: z
      .string({ error: 'facility_id は必須です' })
      .min(1, { error: 'facility_id は必須です' })
      .max(200, { error: 'facility_id が長すぎます' }),
    kind: z
      .enum(ORDER_KINDS, {
        error:
          'kind は case_order / consumable_order / loan_order / loan_return のいずれかで指定してください',
      })
      .optional(),
    ...keywordQueryShape(),
    ...dateRangeShape,
    ...paginationQueryShape(),
  })
)

export async function GET(request: NextRequest): Promise<NextResponse<OrdersApiResponse> | NextResponse<OrdersApiErrorResponse>> {
  const db = await createServerSupabase()
  let user
  try {
    user = await requireAuth(db)
  } catch (e) {
    return authGuardError(e)
  }

  // WHY(2026-09-09): クエリを読むのは parseQuery だけ。日付の判定は refineDateRange、
  //      ページ送りは paginationQueryShape、どちらも共有の 1 か所にある
  const parsed = parseQuery(request, ordersQuerySchema)
  if (!parsed.ok) return parsed.response
  const {
    facility_id: facilityId,
    kind,
    date_from: dateFrom,
    date_to: dateTo,
    keyword,
    limit: rawLimit,
    offset: rawOffset,
  } = parsed.data

  try {
    await requireFacilityAccess(db, user, facilityId)
  } catch (e) {
    if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return ordersApiError('facility_id は必須です', 400)
    return ordersApiError('アクセス権限がありません', 403)
  }

  // WHY: OrdersApiQuery型（src/types/order.ts）を実際に参照することで、route側の
  //      パース結果がSPECで定義した契約と一致していることをコンパイル時に保証する
  //      （レビュー指摘: 型定義が宣言されているのにどこからも参照されていなかった）
  const query: OrdersApiQuery = {
    facilityId,
    limit: rawLimit,
    offset: rawOffset,
    ...(kind ? { kind } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    ...(keyword ? { keyword } : {}),
  }

  try {
    const orders = await listOrders(db, query.facilityId, query, query.limit, query.offset)
    const body: OrdersApiResponse = { orders }
    return NextResponse.json(body)
  } catch (error) {
    return ordersApiError(toClientErrorMessage(error, '発注履歴の取得に失敗しました'))
  }
}
