import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listLoanReturns, createLoanReturn } from '@/lib/loan-returns/repository'
import { apiError, authGuardError, repositoryError, toClientErrorMessage } from '@/lib/api-error'
import { parseQuery } from '@/lib/validation/parse-query'
import { orderListQuerySchema } from '@/lib/orders/list-filter'
import type { LoanReturnInput } from '@/types/order'
import { parseBody } from '@/lib/validation/parse-body'
import { loanReturnInputSchema } from '@/lib/validation/schemas'

export async function GET(request: NextRequest) {
  const db = await createServerSupabase()
  let user
  try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
  // WHY(2026-09-09): クエリを読むのは parseQuery だけ。4 つの一覧 route が同じ形を
  //      別々に書いていたので、形（orderListQuerySchema）も 1 か所へ寄せた
  const parsed = parseQuery(request, orderListQuerySchema)
  if (!parsed.ok) return parsed.response
  const { facility_id: facilityId, limit, offset } = parsed.data
  try {
    // WHY(facilityIdRequired): admin が facility_id を付けないと `.eq('facility_id', undefined)` で 500 になった（2026-09-13 実測）
    await requireFacilityAccess(db, user, facilityId ?? null, { facilityIdRequired: true })
  } catch (e) {
    if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('facility_id は必須です', 400)
    return apiError('アクセス権限がありません', 403)
  }
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
  const parsed = await parseBody(request, loanReturnInputSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  const input: LoanReturnInput = {
    returnDatetime: body.returnDatetime,
    items: body.items,
    clientRequestId: body.clientRequestId,
  }
  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
    try {
      await requireFacilityAccess(db, user, body.facilityId)
    } catch (e) {
      if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('施設IDは必須です', 400)
      return apiError('アクセス権限がありません', 403)
    }
    const loanReturn = await createLoanReturn(db, body.facilityId, input, body.loanOrderId)
    return NextResponse.json({ loanReturn }, { status: 201 })
  } catch (error) {
    // WHY: ClientVisibleError（loanOrderId が自施設に無い・重複返却・未登録の JAN・
    //      業務ルール違反）は利用者の直せる間違いなので 400。判定は repositoryError に集約した
    //      （2026-09-08。他の 3 つの発注 route が 500 のままだったため）
    return repositoryError(error, '返却に失敗しました')
  }
}
