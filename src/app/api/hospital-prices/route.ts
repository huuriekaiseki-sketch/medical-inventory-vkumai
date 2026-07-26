import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listHospitalPrices, createHospitalPrice } from '@/lib/hospital-prices/repository'
import { apiError, toClientErrorMessage } from '@/lib/api-error'
import type { HospitalPriceInput } from '@/types/hospitalPrice'

export async function GET(request: NextRequest) {
  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const facilityId = request.nextUrl.searchParams.get('facilityId')
    let grantedFacilityId: string | null
    try {
      ;({ facilityId: grantedFacilityId } = await requireFacilityAccess(db, user, facilityId))
    } catch (e) {
      if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('facilityId は必須です', 400)
      return apiError('アクセス権限がありません', 403)
    }
    // 認可済みのfacilityIdでクエリも絞る（RLS任せにせず、API契約として指定施設分のみ返す）
    const prices = await listHospitalPrices(db, grantedFacilityId)
    return NextResponse.json({ prices })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '価格の取得に失敗しました'))
  }
}

export async function POST(request: NextRequest) {
  let input: HospitalPriceInput
  try {
    input = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }

  if (!input.distributorProductId || !input.facilityId ||
      input.purchasePrice === undefined || input.purchasePrice === null ||
      input.deliveryPrice === undefined || input.deliveryPrice === null) {
    return apiError('必須項目が未入力です', 400)
  }

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    try {
      await requireFacilityAccess(db, user, input.facilityId)
    } catch (e) {
      if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('facilityId は必須です', 400)
      return apiError('アクセス権限がありません', 403)
    }
    const price = await createHospitalPrice(db, input)
    return NextResponse.json({ price }, { status: 201 })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('既に登録されています')) {
        return apiError(error.message, 409)
      }
      if (error.message.includes('存在しません')) {
        return apiError(error.message, 422)
      }
    }
    return apiError(toClientErrorMessage(error, '価格の作成に失敗しました'))
  }
}
