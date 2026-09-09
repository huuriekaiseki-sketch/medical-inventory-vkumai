import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { parseQuery } from '@/lib/validation/parse-query'

const consumableDeleteQuerySchema = z.object({
  facilityId: z.string().max(200, { error: 'facilityId が長すぎます' }).optional(),
})
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import {
  updateConsumable,
  retireConsumable,
  deleteConsumable,
  CONSUMABLE_NOT_FOUND_ERROR,
  CONSUMABLE_ALREADY_RETIRED_ERROR,
  CONSUMABLE_IN_USE_ERROR,
} from '@/lib/consumables/repository'
import { apiError, authGuardError, repositoryError } from '@/lib/api-error'
import { ClientVisibleError } from '@/lib/client-visible-error'
import { parseBody } from '@/lib/validation/parse-body'
import { consumableInputSchema, consumableRetireSchema } from '@/lib/validation/schemas'
import type { RouteContext } from '@/types/route'

/**
 * 消耗品を直す・止める・消す（2026-09-09）。
 *
 * WHY(そもそも道が無かった): 消耗品は**作成と一覧しかできなかった**。打ち間違えた名前を直せず、
 *      廃番になっても発注の選択肢に残り続ける。いっぽう DB は施設の writer に UPDATE / DELETE を
 *      許していた（`facility_writer_or_admin` は FOR ALL）。E-055 の裏返しの層の食い違い。
 *
 * WHY(施設 ID を本文・クエリで受け取る): 消耗品の API は作成も一覧も `facilityId` を明示的に
 *      受け取る形で揃っている。**利用者が名乗った施設は認可の材料にしかならず**、
 *      repository が `.eq('facility_id', ...)` で絞るので、他施設の ID を指しても 0 行＝404 になる。
 */

/** 施設 ID を確かめて認可する。3 つの動詞で同じ判定を書かないための共通部分 */
async function authorize(db: Awaited<ReturnType<typeof createServerSupabase>>, facilityId: string | null) {
  let user
  try {
    user = await requireAuth(db)
  } catch (e) {
    return { response: authGuardError(e) }
  }
  try {
    await requireFacilityAccess(db, user, facilityId)
  } catch (e) {
    if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') {
      return { response: apiError('施設IDは必須です', 400) }
    }
    return { response: apiError('アクセス権限がありません', 403) }
  }
  return { response: null }
}

/**
 * 名前・用途・JAN を直す。
 *
 * WHY(作成と同じスキーマ): 入口が 1 つなら、文字数の上限も必須の判定も同じ条件で効く。
 *      直す側だけ緩い、という食い違いが起きない
 */
export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params

  const parsed = await parseBody(request, consumableInputSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  const db = await createServerSupabase()
  const guard = await authorize(db, body.facilityId)
  if (guard.response) return guard.response

  try {
    const consumable = await updateConsumable(db, body.facilityId, id, {
      name: body.name,
      jan: body.jan,
      purpose: body.purpose,
    })
    return NextResponse.json({ consumable })
  } catch (error) {
    if (error instanceof ClientVisibleError && error.message === CONSUMABLE_NOT_FOUND_ERROR) {
      return apiError(error.message, 404)
    }
    return repositoryError(error, '消耗品の更新に失敗しました')
  }
}

/**
 * 使用停止にする。
 *
 * WHY(削除と分ける): 発注実績があるものを消すと過去の発注から品目が消える。
 *      止めるだけなら一覧と選択肢から外れ、過去の発注はそのまま残る（人の判断、2026-09-09）
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id } = await context.params

  const parsed = await parseBody(request, consumableRetireSchema)
  if (!parsed.ok) return parsed.response
  const { facilityId } = parsed.data

  const db = await createServerSupabase()
  const guard = await authorize(db, facilityId)
  if (guard.response) return guard.response

  try {
    const consumable = await retireConsumable(db, facilityId, id)
    return NextResponse.json({ consumable })
  } catch (error) {
    // WHY(404 と 409 を分ける): 「無い」と「もう止めてある」は利用者にとって別の話
    if (error instanceof ClientVisibleError) {
      if (error.message === CONSUMABLE_NOT_FOUND_ERROR) return apiError(error.message, 404)
      if (error.message === CONSUMABLE_ALREADY_RETIRED_ERROR) return apiError(error.message, 409)
    }
    return repositoryError(error, '消耗品の使用停止に失敗しました')
  }
}

/**
 * 消す。**発注実績が無いものだけ**。
 *
 * WHY(施設 ID をクエリで受ける): DELETE の本文は経路によっては落ちる。同じ族の GET
 *      （`/api/consumables?facilityId=`）と同じ形にして、送り方を 1 つに揃える
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  // WHY(2026-09-09): クエリを読むのは parseQuery だけ
  const parsed = parseQuery(request, consumableDeleteQuerySchema)
  if (!parsed.ok) return parsed.response
  const facilityId = parsed.data.facilityId ?? null

  const db = await createServerSupabase()
  const guard = await authorize(db, facilityId)
  if (guard.response) return guard.response

  try {
    await deleteConsumable(db, facilityId!, id)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof ClientVisibleError) {
      if (error.message === CONSUMABLE_NOT_FOUND_ERROR) return apiError(error.message, 404)
      // WHY(409): 直し方がある拒否。本文で「使用停止にしてください」と道を示す
      if (error.message === CONSUMABLE_IN_USE_ERROR) return apiError(error.message, 409)
    }
    return repositoryError(error, '消耗品の削除に失敗しました')
  }
}
