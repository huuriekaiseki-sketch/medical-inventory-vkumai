import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listConsumableOrders, createConsumableOrder } from '@/lib/consumable-orders/repository'
import { apiError, authGuardError, repositoryError, toClientErrorMessage } from '@/lib/api-error'
import { parseQuery } from '@/lib/validation/parse-query'
import { orderListQuerySchema } from '@/lib/orders/list-filter'
import { parseBody } from '@/lib/validation/parse-body'
import { consumableOrderInputSchema } from '@/lib/validation/schemas'

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
    const orders = await listConsumableOrders(db, facilityId!, limit, offset)
    return NextResponse.json({ orders })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '消耗品発注一覧の取得に失敗しました'))
  }
}

export async function POST(request: NextRequest) {
  const parsed = await parseBody(request, consumableOrderInputSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  // WHY: 「1 つ以上」は業務の条件（空の発注に意味が無い）。形の検証とは別なのでここに残す
  if (body.items.length === 0) return apiError('発注物品を1つ以上選択してください', 400)

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
    const order = await createConsumableOrder(db, body.facilityId, { items: body.items, clientRequestId: body.clientRequestId })
    return NextResponse.json({ order }, { status: 201 })
  } catch (error) {
    return repositoryError(error, '発注に失敗しました')
  }
}
