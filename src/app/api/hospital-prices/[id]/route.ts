import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { getHospitalPrice, updateHospitalPrice, deleteHospitalPrice } from '@/lib/hospital-prices/repository'
import { apiError } from '@/lib/api-error'
import type { HospitalPriceInput } from '@/types/hospitalPrice'
import type { RouteContext } from '@/types/route'

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const db = await createServerSupabase()
  let user
  try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
  const price = await getHospitalPrice(db, id)
  if (!price) {
    return NextResponse.json({ error: '病院別価格が見つかりません' }, { status: 404 })
  }
  try {
    await requireFacilityAccess(db, user, price.facilityId)
  } catch {
    return apiError('アクセス権限がありません', 403)
  }
  return NextResponse.json({ price })
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  let input: HospitalPriceInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.distributorProductId || !input.facilityId ||
      input.purchasePrice === undefined || input.deliveryPrice === undefined) {
    return NextResponse.json({ error: '必須項目が未入力です' }, { status: 400 })
  }

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const existing = await getHospitalPrice(db, id)
    if (!existing) {
      return NextResponse.json({ error: '価格情報が見つかりません' }, { status: 404 })
    }
    // WHY: input.facilityId はリクエストボディ（クライアント入力）のため、それだけで権限判定すると
    // 「自分の施設ID」を詐称して他施設のレコードを更新できてしまう。既存レコードの実facilityIdで
    // まずアクセス権を確認し、施設付け替え（input.facilityIdが異なる）の場合は移動先施設への
    // アクセス権も別途確認する。
    try {
      await requireFacilityAccess(db, user, existing.facilityId)
      if (input.facilityId !== existing.facilityId) {
        await requireFacilityAccess(db, user, input.facilityId)
      }
    } catch {
      return apiError('アクセス権限がありません', 403)
    }
    const price = await updateHospitalPrice(db, id, input)
    return NextResponse.json({ price })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('病院別価格ID')) {
        return NextResponse.json({ error: '価格情報が見つかりません' }, { status: 404 })
      }
      if (error.message.includes('代理店商品または施設が存在しません')) {
        return NextResponse.json({ error: error.message }, { status: 422 })
      }
      if (error.message.includes('既に登録されています')) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
    }
    throw error
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const existing = await getHospitalPrice(db, id)
    if (!existing) {
      return NextResponse.json({ error: '病院別価格が見つかりません' }, { status: 404 })
    }
    try {
      await requireFacilityAccess(db, user, existing.facilityId)
    } catch {
      return apiError('アクセス権限がありません', 403)
    }
    await deleteHospitalPrice(db, id)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return NextResponse.json({ error: '病院別価格が見つかりません' }, { status: 404 })
    }
    throw error
  }
}
