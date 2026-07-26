import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { apiError, toClientErrorMessage } from '@/lib/api-error'
import { isValidDateString } from '@/lib/jst-date-range'
import { fetchOrderAmountReport } from '@/lib/reports/repository'
import type {
  OrderAmountReportApiErrorResponse,
  OrderAmountReportApiQuery,
  OrderAmountReportApiResponse,
} from '@/types/report'

// WHY: apiError は共通の { error: string } 形式を返すが、OrderAmountReportApiErrorResponse型と
//      一致していることをコンパイル時に保証するため、戻り値をこの型でラップして返す
function reportsApiError(message: string, status = 500): NextResponse<OrderAmountReportApiErrorResponse> {
  return apiError(message, status)
}

// GET /api/admin/reports?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
// 施設別 × 発注種別（症例発注/消耗品発注/短貸発注）の発注金額集計をadminのみ閲覧できるAPI（issue #23 Part2 Set D）
export async function GET(
  request: NextRequest,
): Promise<NextResponse<OrderAmountReportApiResponse> | NextResponse<OrderAmountReportApiErrorResponse>> {
  const db = await createServerSupabase()

  let user
  try {
    user = await requireAuth(db)
  } catch {
    return reportsApiError('認証が必要です', 401)
  }

  // WHY: requireAdmin()(admin-auth.ts)は未認証/非adminをどちらもnullで返し401/403を区別できない。
  //      本APIは受け入れ条件で401(未認証)と403(非admin)を明確に分けることが求められているため、
  //      requireAuth()で認証チェック済みのユーザーに対してresolveIsAdmin()で個別にadmin判定する
  const isAdmin = await resolveIsAdmin(db, user)
  if (!isAdmin) return reportsApiError('権限がありません', 403)

  const params = request.nextUrl.searchParams
  const dateFrom = params.get('date_from')
  const dateTo = params.get('date_to')

  if (dateFrom && !isValidDateString(dateFrom)) {
    return reportsApiError('date_from は YYYY-MM-DD 形式で指定してください', 400)
  }
  if (dateTo && !isValidDateString(dateTo)) {
    return reportsApiError('date_to は YYYY-MM-DD 形式で指定してください', 400)
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return reportsApiError('date_from は date_to 以前の日付を指定してください', 400)
  }

  const query: OrderAmountReportApiQuery = {
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
  }

  try {
    const rows = await fetchOrderAmountReport(db, query)
    const body: OrderAmountReportApiResponse = { rows }
    return NextResponse.json(body)
  } catch (error) {
    // WHY: RPC(get_order_amount_report)内のis_admin()チェックはservice_roleを経由しない
    //      SECURITY DEFINER関数だが、二重防御として万一permission deniedが漏れてきた場合も
    //      500で隠さず403に変換する（Part2 Set D仕様）
    const message = error instanceof Error ? error.message : ''
    if (message.includes('permission denied')) {
      return reportsApiError('権限がありません', 403)
    }
    return reportsApiError(toClientErrorMessage(error, '発注金額レポートの取得に失敗しました'))
  }
}
