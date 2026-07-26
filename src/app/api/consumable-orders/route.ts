import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listConsumableOrders, createConsumableOrder } from '@/lib/consumable-orders/repository'
import { apiError, toClientErrorMessage } from '@/lib/api-error'
import { parsePagination } from '@/lib/api-pagination'
import type { ConsumableOrderInput } from '@/types/order'

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
    const orders = await listConsumableOrders(db, facilityId!, limit, offset)
    return NextResponse.json({ orders })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '消耗品発注一覧の取得に失敗しました'))
  }
}

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<ConsumableOrderInput>
  try {
    body = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!body.facilityId) return apiError('施設IDは必須です', 400)
  if (!body.items?.length) return apiError('発注物品を1つ以上選択してください', 400)

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
    const order = await createConsumableOrder(db, body.facilityId, { items: body.items })
    return NextResponse.json({ order }, { status: 201 })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '発注に失敗しました'))
  }
}
