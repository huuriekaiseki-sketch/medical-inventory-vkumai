import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listLoanReturns, createLoanReturn } from '@/lib/loan-returns/repository'
import { apiError, toClientErrorMessage } from '@/lib/api-error'
import { ClientVisibleError } from '@/lib/client-visible-error'
import { parsePagination } from '@/lib/api-pagination'
import type { LoanReturnInput } from '@/types/order'

export async function GET(request: NextRequest) {
  const db = await createServerSupabase()
  let user
  try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
  const facilityId = request.nextUrl.searchParams.get('facility_id')
  try {
    await requireFacilityAccess(db, user, facilityId)
  } catch (e) {
    if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('facility_id は必須です', 400)
    return apiError('アクセス権限がありません', 403)
  }
  const pagination = parsePagination(request.nextUrl.searchParams)
  if (!pagination.ok) return pagination.response
  const { limit, offset } = pagination
  try {
    const returns = await listLoanReturns(db, facilityId!, limit, offset)
    return NextResponse.json({ returns })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '返却一覧の取得に失敗しました'))
  }
}

export async function POST(request: NextRequest) {
  // WHY: loanOrderId は LoanReturnInput 型の契約外（型定義は変更しない）だが、
  //      loan_returns.loan_order_id（issue #20 Set A）へ紐付けないと「未返却」バッジが
  //      新規返却でも永久に解消されないバグになる（レビュー指摘）。bodyから別フィールドとして
  //      受け取り、createLoanReturn の第4引数としてそのまま渡す
  let body: { facilityId?: string; loanOrderId?: string } & Partial<LoanReturnInput>
  try {
    body = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!body.facilityId) return apiError('施設IDは必須です', 400)
  if (!body.returnDatetime) return apiError('返却日時は必須です', 400)
  if (body.items && body.items.some((item: { jan?: string }) => !item.jan?.trim())) {
    return apiError('JANは必須です', 400)
  }

  const input: LoanReturnInput = {
    returnDatetime: body.returnDatetime,
    items: body.items ?? [],
  }
  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    try {
      await requireFacilityAccess(db, user, body.facilityId)
    } catch (e) {
      if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('施設IDは必須です', 400)
      return apiError('アクセス権限がありません', 403)
    }
    const loanReturn = await createLoanReturn(db, body.facilityId, input, body.loanOrderId)
    return NextResponse.json({ loanReturn }, { status: 201 })
  } catch (error) {
    // WHY: ClientVisibleError は repository層が「クライアントに見せてよいと翻訳済み」と
    //      保証したエラー（loanOrderIdが自施設に存在しない場合の LOAN_ORDER_NOT_FOUND_ERROR、
    //      および今回追加されたUNIQUE制約違反(23505)時の重複返却エラーの両方を含む）。
    //      consumables/route.ts と同じ経路に統一し、個別の文字列比較を廃止する
    //      （issue #675 Part2 セットB）
    if (error instanceof ClientVisibleError) return apiError(error.message, 400)
    return apiError(toClientErrorMessage(error, '返却に失敗しました'))
  }
}
