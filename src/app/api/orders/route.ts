import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listOrders } from '@/lib/orders/repository'
import { apiError, toClientErrorMessage } from '@/lib/api-error'
import { parsePagination } from '@/lib/api-pagination'
import { isValidDateString } from '@/lib/jst-date-range'
import type { OrderKind, OrdersApiErrorResponse, OrdersApiQuery, OrdersApiResponse } from '@/types/order'

// WHY: apiError は共通の { error: string } 形式を返すが、OrdersApiErrorResponse型と一致していることを
//      コンパイル時に保証するため、戻り値をこの型でラップして返す
function ordersApiError(message: string, status = 500): NextResponse<OrdersApiErrorResponse> {
  return apiError(message, status)
}

const ORDER_KINDS: readonly OrderKind[] = ['case_order', 'consumable_order', 'loan_order', 'loan_return']

export async function GET(request: NextRequest): Promise<NextResponse<OrdersApiResponse> | NextResponse<OrdersApiErrorResponse>> {
  const db = await createServerSupabase()
  let user
  try {
    user = await requireAuth(db)
  } catch {
    return ordersApiError('認証が必要です', 401)
  }

  const params = request.nextUrl.searchParams
  const facilityId = params.get('facility_id')
  // WHY: 発注履歴は横断一覧のため facility_id は他 route と異なり常に必須
  //      （admin であっても施設未指定の全件横断は本 issue のスコープ外）
  if (!facilityId) return ordersApiError('facility_id は必須です', 400)

  try {
    await requireFacilityAccess(db, user, facilityId)
  } catch (e) {
    if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return ordersApiError('facility_id は必須です', 400)
    return ordersApiError('アクセス権限がありません', 403)
  }

  const kind = params.get('kind')
  if (kind && !ORDER_KINDS.includes(kind as OrderKind)) {
    return ordersApiError('kind は case_order / consumable_order / loan_order / loan_return のいずれかで指定してください', 400)
  }

  const pagination = parsePagination(params)
  if (!pagination.ok) return pagination.response
  const { limit: rawLimit, offset: rawOffset } = pagination

  const dateFrom = params.get('date_from')
  const dateTo = params.get('date_to')
  const keyword = params.get('keyword')

  // WHY: 不正な日付文字列（date_from=abc等）をそのままjstDayStart/jstDayEndに渡すと、
  //      Supabaseクエリがエラーになり500として露出してしまう（レビュー指摘: 型安全・データ層 important）。
  //      API境界で形式を検証し、不正なら400で明示的に弾く
  if (dateFrom && !isValidDateString(dateFrom)) {
    return ordersApiError('date_from は YYYY-MM-DD 形式で指定してください', 400)
  }
  if (dateTo && !isValidDateString(dateTo)) {
    return ordersApiError('date_to は YYYY-MM-DD 形式で指定してください', 400)
  }

  // WHY: OrdersApiQuery型（src/types/order.ts）を実際に参照することで、route側の
  //      パース結果がSPECで定義した契約と一致していることをコンパイル時に保証する
  //      （レビュー指摘: 型定義が宣言されているのにどこからも参照されていなかった）
  const query: OrdersApiQuery = {
    facilityId,
    limit: rawLimit,
    offset: rawOffset,
    ...(kind ? { kind: kind as OrderKind } : {}),
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
