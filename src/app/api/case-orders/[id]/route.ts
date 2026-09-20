import { NextRequest, NextResponse } from 'next/server'
import type { RouteContext } from '@/types/route'
import { handleOrderCancel } from '@/lib/orders/cancel-route'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { recordHiddenRowDenial } from '@/lib/security/hidden-row-denial'
import { getCaseOrder } from '@/lib/case-orders/repository'
import { authGuardError, apiError, repositoryError } from '@/lib/api-error'
import { isUuid } from '@/lib/validation/uuid'

/** 症例発注の取り消し（E-056）。認可とエラーの写し分けは 3 種で共有する */
export async function PATCH(request: NextRequest, context: RouteContext) {
  return handleOrderCancel(request, context.params, 'case_orders')
}

/**
 * 症例発注の詳細（issue #809）。
 *
 * WHY(先引き→施設判定、SPEC.md Part 2): repository は施設 ID を引数に取らない
 *      `getCaseOrder(db, id)`。見つからない（存在しない・RLS で見えない）は `null` を返し、
 *      route はそれを `recordHiddenRowDenial` で access_denials に残してから 404 を返す
 *      （存在の有無を漏らさない）。見つかったあとに `requireFacilityAccess` が失敗しても
 *      403 ではなく 404 にする（起きるとすれば admin/一般メンバーいずれも通常起きない経路で、
 *      起きたら存在を漏らさない側に倒す）。
 *
 * WHY(requireAuth を ID の形式チェックより先にする、SPEC.md Part 2「認可の形」):
 *      「`requireAuth` → ID の形式 → `get*` → …」の順で書かれている。未認証者に対しては
 *      形式の正否すら判定せず先に 401 で止める（認可のゲートを他のどの判定より先に通す）。
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const db = await createServerSupabase()
  let user
  try {
    user = await requireAuth(db)
  } catch (e) {
    return authGuardError(e)
  }
  if (!isUuid(id)) {
    return apiError('症例発注が見つかりません', 404)
  }
  let caseOrder
  try {
    caseOrder = await getCaseOrder(db, id)
  } catch (error) {
    return repositoryError(error, '症例発注の取得に失敗しました')
  }
  if (!caseOrder) {
    await recordHiddenRowDenial({ table: 'case_orders', id, actorId: user.id })
    return apiError('症例発注が見つかりません', 404)
  }
  try {
    await requireFacilityAccess(db, user, caseOrder.facilityId)
  } catch {
    return apiError('症例発注が見つかりません', 404)
  }
  return NextResponse.json({ caseOrder })
}
