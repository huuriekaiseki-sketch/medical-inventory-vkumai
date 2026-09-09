import { NextRequest, NextResponse } from 'next/server'
import { isUuid } from '@/lib/validation/uuid'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { deleteCompatibility } from '@/lib/compatibilities/repository'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import type { RouteContext } from '@/types/route'

// WHY: idはDB上uuid型のため、不正形式のまま渡すとPostgres側の生のパースエラーが
// 未捕捉の500として漏れてしまう。SPEC通りの404「すでに削除されています」に寄せず
// 明示的に400で弾く（他のroute.tsのUUID_RE検証と同じ方針）。
// WHY(2026-09-09): 判定は validation/uuid.ts へ寄せた（ここはパスの一部なのでクエリの入口は通らない）

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }

    const isAdmin = await resolveIsAdmin(db, user)
    if (!isAdmin) return apiError('権限がありません', 403)

    const { id } = await context.params

    if (!isUuid(id)) {
      return apiError('IDの形式が不正です', 400)
    }

    // WHY: repository層は「削除件数0件」を判定可能な形で返す契約（SPEC Part2 Set C）。
    // 既に他管理者が削除済みの場合はfalseが返り、404として扱う。
    const deleted = await deleteCompatibility(db, id)
    if (!deleted) {
      return apiError('すでに削除されています', 404)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '互換品の削除に失敗しました'))
  }
}
