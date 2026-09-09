import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { apiError, authGuardError, repositoryError } from '@/lib/api-error'
import { ClientVisibleError } from '@/lib/client-visible-error'
import { parseBody } from '@/lib/validation/parse-body'
import { orderCancelSchema } from '@/lib/validation/schemas'
import {
  cancelOrder,
  ORDER_ALREADY_CANCELLED_ERROR,
  ORDER_HAS_RETURNS_ERROR,
  ORDER_NOT_FOUND_ERROR,
  type CancellableOrderTable,
} from '@/lib/orders/cancel'

/**
 * 発注の取り消しハンドラ（症例・消耗品・短貸の 3 route が共有する。E-056）。
 *
 * WHY(3 つの route で同じ本文を書かない): 認可の順番・エラーの写し分けを 3 回書くと、
 *      1 つだけ抜ける形の失敗が入る。**認可の判断はここ 1 か所**にして、
 *      route 側は「どの表か」だけを渡す。
 *
 * WHY(DELETE ではなく PATCH・action を必須にする): 行は消さず `cancelled` にする。
 *      状態を自由に入れられる形にすると `submitted` へ戻す経路を後から足せてしまうので、
 *      **できるのは取り消しだけ**を入口の形で示す（DB の「cancelled からは戻れない」と二重）。
 */
export async function handleOrderCancel(
  request: NextRequest,
  params: Promise<{ id: string }>,
  table: CancellableOrderTable
): Promise<NextResponse> {
  const { id } = await params

  const parsed = await parseBody(request, orderCancelSchema)
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
    const order = await cancelOrder(db, table, facilityId, id)
    return NextResponse.json({ order })
  } catch (error) {
    // WHY(404 と 409 を分ける): 「無い」と「もう取り消してある」は利用者にとって別の話
    if (error instanceof ClientVisibleError) {
      if (error.message === ORDER_NOT_FOUND_ERROR) return apiError(error.message, 404)
      if (error.message === ORDER_ALREADY_CANCELLED_ERROR) return apiError(error.message, 409)
      // 返却が残っている（I-022）。利用者が先にやることがあるので 409 で返す
      if (error.message === ORDER_HAS_RETURNS_ERROR) return apiError(error.message, 409)
    }
    return repositoryError(error, '発注の取り消しに失敗しました')
  }
}
