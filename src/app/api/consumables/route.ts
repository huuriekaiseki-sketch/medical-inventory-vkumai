import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { parseQuery } from '@/lib/validation/parse-query'

// WHY(既定では使用停止を返さない、2026-09-09): 呼び出し元の多くは発注の選択肢として使う。
//      管理の画面だけが `includeRetired=1` を付ける。**明示しない限り安全側**にしておかないと、
//      新しい呼び出し元が黙って止めたものを混ぜる。
//      判定（'1' だけを真とする）は移行前と同じ——ここを緩めると意味が変わる
const consumablesQuerySchema = z.object({
  facilityId: z.string().max(200, { error: 'facilityId が長すぎます' }).optional(),
  includeRetired: z
    .string()
    .optional()
    .transform((v) => v === '1'),
})
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listConsumablesByFacility, createConsumable } from '@/lib/consumables/repository'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import { ClientVisibleError } from '@/lib/client-visible-error'
import { consumableInputSchema } from '@/lib/validation/schemas'
import { parseBody } from '@/lib/validation/parse-body'

export async function GET(request: NextRequest) {
  const db = await createServerSupabase()
  let user
  try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
  const parsed = parseQuery(request, consumablesQuerySchema)
  if (!parsed.ok) return parsed.response
  const { facilityId, includeRetired } = parsed.data
  try {
    // WHY(facilityIdRequired): admin が facility_id を付けないと `.eq('facility_id', undefined)` で 500 になった（2026-09-13 実測）
    await requireFacilityAccess(db, user, facilityId ?? null, { facilityIdRequired: true })
  } catch (e) {
    if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('施設IDは必須です', 400)
    return apiError('アクセス権限がありません', 403)
  }
  try {
    const consumables = await listConsumablesByFacility(db, facilityId!, { includeRetired })
    return NextResponse.json({ consumables })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '消耗品の取得に失敗しました'))
  }
}

export async function POST(request: NextRequest) {
  // WHY(#757-20): 本文を読む唯一の入口。必須だけでなく長さも見る（以前はどちらも無く、
  //      1 MB の文字列が DB の CHECK まで素通りしていた）。request.json() の直接呼び出しは
  //      eslint で禁止してあるので、この経路を飛ばすことはできない
  const parsed = await parseBody(request, consumableInputSchema)
  if (!parsed.ok) return parsed.response
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
