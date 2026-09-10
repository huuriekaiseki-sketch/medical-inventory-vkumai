import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import {
  getHospitalPrice,
  updateHospitalPrice,
  deleteHospitalPrice,
  HOSPITAL_PRICE_CONFLICT_MESSAGE,
} from '@/lib/hospital-prices/repository'
import { authGuardError, apiError } from '@/lib/api-error'
import { ClientVisibleError } from '@/lib/client-visible-error'
import type { RouteContext } from '@/types/route'
import { parseBody } from '@/lib/validation/parse-body'
import { hospitalPriceInputSchema } from '@/lib/validation/schemas'

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const db = await createServerSupabase()
  let user
  try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
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
  const parsed = await parseBody(request, hospitalPriceInputSchema)
  if (!parsed.ok) return parsed.response
  const input = parsed.data

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
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
    // WHY(2026-09-11): `Error` ではなく `ClientVisibleError` を見る。
    //      ここは分岐の先で **error.message をそのまま利用者へ返す**ので、`Error` で受けると
    //      DB の生エラーが偶然この文言を含んだときに素通りする道が残る。
    //      翻訳済みだと分かっているもの（`client-visible-error.ts` のマーカー）だけを通す。
    //      現実に起きる確率は低い（PostgreSQL のエラーは英語）が、**構造で閉じる**ほうを採る。
    //      見つけたのは held-out の eval で Sweep がこの route を挙げたとき。
    //      指摘そのもの（「生の message を返している」）は**この形では誤り**だったが、
    //      判定が `instanceof Error` だったのは事実なので、そこだけ締めた。
    if (error instanceof ClientVisibleError) {
      if (error.message.includes('病院別価格ID')) {
        return NextResponse.json({ error: '価格情報が見つかりません' }, { status: 404 })
      }
      if (error.message.includes('代理店商品または施設が存在しません')) {
        return NextResponse.json({ error: error.message }, { status: 422 })
      }
      if (error.message.includes('既に登録されています')) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      // 楽観ロックの競合（P-052）。UNIQUE 違反と同じ 409 だが、本文で区別できるようメッセージを返す
      if (error.message === HOSPITAL_PRICE_CONFLICT_MESSAGE) {
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
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
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
