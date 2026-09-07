import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listHospitalPrices, createHospitalPrice } from '@/lib/hospital-prices/repository'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import { parseBody } from '@/lib/validation/parse-body'
import { hospitalPriceInputSchema } from '@/lib/validation/schemas'

export async function GET(request: NextRequest) {
  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
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
  const parsed = await parseBody(request, hospitalPriceInputSchema)
  if (!parsed.ok) return parsed.response
  const input = parsed.data

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
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
