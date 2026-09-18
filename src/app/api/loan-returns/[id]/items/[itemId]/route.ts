import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import {
  cancelLoanReturnItem,
  LOAN_RETURN_ALREADY_CANCELLED_ERROR,
  LOAN_RETURN_ITEM_ALREADY_CANCELLED_ERROR,
  LOAN_RETURN_ITEM_NOT_FOUND_ERROR,
  LOAN_RETURN_NOT_FOUND_ERROR,
} from '@/lib/loan-returns/repository'
import { apiError, authGuardError, repositoryError } from '@/lib/api-error'
import { ClientVisibleError } from '@/lib/client-visible-error'
import { parseBody } from '@/lib/validation/parse-body'
import { loanReturnCancelSchema } from '@/lib/validation/schemas'

/**
 * 返却の**明細 1 件**の取り消し（E-056 の残り、2026-09-09）。
 *
 * WHY(親の route と分ける): 親（`/api/loan-returns/[id]`）は返却まるごとの取り消し。
 *      ここは「1 回の返却のうち、この品目だけが間違いだった」を直す道で、意味が違う。
 *      同じ route に `itemId` の有無で分岐を足すと、**片方の認可だけを直す**事故が起きる
 *      （層の食い違いは E-053 / E-055 で 2 回踏んでいる）。
 *
 * WHY(本文は親と同じ形): `{ facilityId, action: 'cancel' }` だけを受ける。
 *      **できるのは取り消しだけ**であることを入口の形で示す（親と同じスキーマを共有する）。
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string; itemId: string }> }
) {
  const { id, itemId } = await context.params

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
    const item = await cancelLoanReturnItem(db, facilityId, id, itemId)
    return NextResponse.json({ item })
  } catch (error) {
    // WHY(404 と 409 を分ける): 「無い」と「もう取り消してある」は利用者にとって別の話。
    //      親ごと取り消し済みの場合も 409 に写す（明細を個別に取り消す意味が無い状態）
    if (error instanceof ClientVisibleError) {
      if (
        error.message === LOAN_RETURN_NOT_FOUND_ERROR ||
        error.message === LOAN_RETURN_ITEM_NOT_FOUND_ERROR
      ) {
        return apiError(error.message, 404)
      }
      if (
        error.message === LOAN_RETURN_ALREADY_CANCELLED_ERROR ||
        error.message === LOAN_RETURN_ITEM_ALREADY_CANCELLED_ERROR
      ) {
        return apiError(error.message, 409)
      }
    }
    return repositoryError(error, '明細の取り消しに失敗しました')
  }
}
