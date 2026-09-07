import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listConsumablesByFacility, createConsumable } from '@/lib/consumables/repository'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import { ClientVisibleError } from '@/lib/client-visible-error'
import { consumableInputSchema } from '@/lib/validation/schemas'
import { firstIssueMessage } from '@/lib/validation/text-limits'

export async function GET(request: NextRequest) {
  const db = await createServerSupabase()
  let user
  try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
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
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  // WHY(#757-20): 必須の検査だけでなく長さも入口で見る。以前はどちらの route にも
  //      長さの検査が無く、1 MB の文字列が DB の CHECK まで素通りしていた
  const parsed = consumableInputSchema.safeParse(raw)
  if (!parsed.success) return apiError(firstIssueMessage(parsed.error), 400)
  const body = parsed.data

  const db = await createServerSupabase()
  let user
  try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
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
    // WHY: 存在しないJANを指定した場合(consumables.jan → products(jan) のFK違反)は、
    //      サーバ側の問題ではなくクライアント入力の不備なので400として返す
    //      (issue #647 レビュー指摘: FK違反時に汎用500になっていた境界条件の対応)。
    if (error instanceof ClientVisibleError) return apiError(error.message, 400)
    return apiError(toClientErrorMessage(error, '消耗品の作成に失敗しました'))
  }
}
