import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { getFacility, updateFacility } from '@/lib/facilities/repository'
import { authGuardError, apiError } from '@/lib/api-error'
import type { RouteContext } from '@/types/route'
import { parseBody } from '@/lib/validation/parse-body'
import { facilityInputSchema } from '@/lib/validation/schemas'

// WHY(DELETE を置かない、2026-09-08・E-055): 施設を消す道はここに DELETE として存在していたが、
//      `facilities` には **DELETE の RLS ポリシーが 1 つも無い**ので、admin が叩いても 0 行になり、
//      実在する施設に対して 404「施設が見つかりません」を返していた。画面に削除ボタンは無く、
//      呼ぶ経路も無かった（**使えない道が残っていただけ**）。
//      施設の削除は発注・価格・所属・監査まで連鎖する戻せない操作なので、運用で必要になったときに
//      「誰が消せるか」を決めてから RLS ごと作る。**それまで道を残さない。**
//      連鎖そのものの検証（I-052）は service_role で行う統合テストが引き続き受け持つ。

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const db = await createServerSupabase()
  try { await requireAuth(db) } catch (e) { return authGuardError(e) }
  const facility = await getFacility(db, id)
  if (!facility) {
    return NextResponse.json({ error: '施設が見つかりません' }, { status: 404 })
  }
  return NextResponse.json({ facility })
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const parsed = await parseBody(request, facilityInputSchema)
  if (!parsed.ok) return parsed.response
  const input = parsed.data

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
    const isAdmin = await resolveIsAdmin(db, user)
    if (!isAdmin) return apiError('権限がありません', 403)
    const facility = await updateFacility(db, id, input)
    return NextResponse.json({ facility })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('存在しません')) {
        return NextResponse.json({ error: '施設が見つかりません' }, { status: 404 })
      }
      if (error.message.includes('既に使用されています')) {
        return NextResponse.json({ error: '施設名が重複しています' }, { status: 409 })
      }
    }
    throw error
  }
}
