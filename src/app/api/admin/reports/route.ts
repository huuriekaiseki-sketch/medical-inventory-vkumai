import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import { dateRangeShape, refineDateRange } from '@/lib/jst-date-range'
import { parseQuery } from '@/lib/validation/parse-query'
import { fetchOrderAmountReport } from '@/lib/reports/repository'
import type {
  OrderAmountReportApiErrorResponse,
  OrderAmountReportApiQuery,
  OrderAmountReportApiResponse,
} from '@/types/report'

// WHY(2026-09-09、クエリの判定を共有へ): 日付の 3 条件（date_from の形式・date_to の形式・前後関係）は
//      監査 route（/api/admin/audit）に**同じ文言で 2 回**書かれていた。片方だけ直せば食い違う形なので、
//      判定は `refineDateRange` の 1 か所へ寄せ、読み取りは `parseQuery` に一本化する。
const reportsQuerySchema = refineDateRange(z.object({ ...dateRangeShape }))

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
  } catch (e) {
    return authGuardError(e)
  }

  // WHY: requireAdmin()(admin-auth.ts)は未認証/非adminをどちらもnullで返し401/403を区別できない。
  //      本APIは受け入れ条件で401(未認証)と403(非admin)を明確に分けることが求められているため、
  //      requireAuth()で認証チェック済みのユーザーに対してresolveIsAdmin()で個別にadmin判定する
  const isAdmin = await resolveIsAdmin(db, user)
  if (!isAdmin) return reportsApiError('権限がありません', 403)

  const parsed = parseQuery(request, reportsQuerySchema)
  if (!parsed.ok) return parsed.response
  const { date_from: dateFrom, date_to: dateTo } = parsed.data

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
