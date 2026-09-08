import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import {
  cancelLoanReturn,
  LOAN_RETURN_ALREADY_CANCELLED_ERROR,
  LOAN_RETURN_NOT_FOUND_ERROR,
} from '@/lib/loan-returns/repository'
import { apiError, authGuardError, repositoryError } from '@/lib/api-error'
import { ClientVisibleError } from '@/lib/client-visible-error'
import type { RouteContext } from '@/types/route'
import { parseBody } from '@/lib/validation/parse-body'
import { loanReturnCancelSchema } from '@/lib/validation/schemas'

/**
 * 返却の取り消し（E-056）。
 *
 * WHY(DELETE ではなく PATCH): 行は消さず `cancelled` にする。人が
 *      「取り消し状態を作る」と判断した（2026-09-08）。**誰がいつ何を取り消したか**を
 *      残すため（監査トリガーが status の変更を記録する）。DELETE にすると業務の一覧から
 *      消えてしまい、「間違えた返却があった」こと自体が追えなくなる。
 *
 * WHY(本文で cancel を明示させる): 状態を自由に入れられる PATCH にすると、画面が
 *      `returned` へ戻す・`draft` にする、といった経路を後から足せてしまう。
 *      **できるのは取り消しだけ**であることを入口の形で示す。
 *      DB 側も「取り消しからは戻れない」をトリガーで守っている（多層）。
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id } = await context.params

  const parsed = await parseBody(request, loanReturnCancelSchema)
  if (!parsed.ok) return parsed.response
  const { facilityId } = parsed.data

  const db = await createServerSupabase()
  let user
  try {
    user = await requireAuth(db)
  } catch (e) {
    return authGuardError(e)
  }
  try {
    await requireFacilityAccess(db, user, facilityId)
  } catch (e) {
    if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') {
      return apiError('施設IDは必須です', 400)
    }
    return apiError('アクセス権限がありません', 403)
  }

  try {
    const loanReturn = await cancelLoanReturn(db, facilityId, id)
    return NextResponse.json({ return: loanReturn })
  } catch (error) {
    // WHY(404 と 409 を分ける): 「無い」と「もう取り消してある」は利用者にとって別の話。
    //      どちらも ClientVisibleError なので、文言で写し分ける
    if (error instanceof ClientVisibleError) {
      if (error.message === LOAN_RETURN_NOT_FOUND_ERROR) return apiError(error.message, 404)
      if (error.message === LOAN_RETURN_ALREADY_CANCELLED_ERROR) return apiError(error.message, 409)
    }
    return repositoryError(error, '返却の取り消しに失敗しました')
  }
}
