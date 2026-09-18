import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { parseQuery } from '@/lib/validation/parse-query'

const hospitalPricesQuerySchema = z.object({
  facilityId: z.string().max(200, { error: 'facilityId が長すぎます' }).optional(),
})
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listHospitalPrices, createHospitalPrice } from '@/lib/hospital-prices/repository'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import { ClientVisibleError } from '@/lib/client-visible-error'
import { parseBody } from '@/lib/validation/parse-body'
import { hospitalPriceInputSchema } from '@/lib/validation/schemas'

export async function GET(request: NextRequest) {
  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
    // WHY(2026-09-09): クエリを読むのは parseQuery だけ。越境は所属判定と RLS が止めるので、
    //      ここは「明らかに変な値」を落とすだけにする
    const parsed = parseQuery(request, hospitalPricesQuerySchema)
    if (!parsed.ok) return parsed.response

    let grantedFacilityId: string | null
    try {
      ;({ facilityId: grantedFacilityId } = await requireFacilityAccess(
        db,
        user,
        parsed.data.facilityId ?? null
      ))
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
    // WHY(2026-09-11): `Error` ではなく `ClientVisibleError` を見る。
    //      分岐の先で **error.message をそのまま返す**ので、`Error` で受けると
    //      DB の生エラーが偶然この文言を含んだときに素通りする道が残る
    //      （`client-visible-error.ts` は、まさにその漏洩対策のマーカー）。
    //      ここを外れたものは下の `toClientErrorMessage` がサニタイズする。
    if (error instanceof ClientVisibleError) {
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
