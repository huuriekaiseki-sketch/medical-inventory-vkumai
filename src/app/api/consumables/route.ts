import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listConsumablesByFacility, createConsumable } from '@/lib/consumables/repository'
import { apiError, toClientErrorMessage } from '@/lib/api-error'
import type { ConsumableInput } from '@/types/order'

export async function GET(request: NextRequest) {
  const db = await createServerSupabase()
  let user
  try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
  const facilityId = request.nextUrl.searchParams.get('facilityId')
  try {
    await requireFacilityAccess(db, user, facilityId)
  } catch (e) {
    if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('施設IDは必須です', 400)
    return apiError('アクセス権限がありません', 403)
  }
  try {
    const consumables = await listConsumablesByFacility(db, facilityId!)
    return NextResponse.json({ consumables })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '消耗品の取得に失敗しました'))
  }
}

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<ConsumableInput>
  try {
    body = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!body.facilityId) return apiError('施設IDは必須です', 400)
  if (!body.name?.trim()) return apiError('品名は必須です', 400)
  if (!body.purpose?.trim()) return apiError('用途は必須です', 400)

  const db = await createServerSupabase()
  let user
  try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
  try {
    await requireFacilityAccess(db, user, body.facilityId)
  } catch (e) {
    if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('施設IDは必須です', 400)
    return apiError('アクセス権限がありません', 403)
  }

  try {
    const consumable = await createConsumable(db, body.facilityId, {
      name: body.name,
      jan: body.jan,
      purpose: body.purpose,
    })
    return NextResponse.json({ consumable }, { status: 201 })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '消耗品の作成に失敗しました'))
  }
}
