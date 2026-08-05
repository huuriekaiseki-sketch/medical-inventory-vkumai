import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { getUserFacilityRole } from '@/lib/user-facilities/repository'
import { apiError, toClientErrorMessage } from '@/lib/api-error'
import type { RouteContext } from '@/types/route'

// WHY: viewerロールのUIゲーティング(issue #608)用。自分が指定施設で
//      admin/staff/viewerのどれか、あるいは未所属(null)かを返す。
//      adminはuser_facilitiesに行が無くても全施設を操作できるため、
//      resolveIsAdminを先に見て早期にadmin扱いする。
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const db = await createServerSupabase()
  let user
  try {
    user = await requireAuth(db)
  } catch {
    return apiError('認証が必要です', 401)
  }

  try {
    const isAdmin = await resolveIsAdmin(db, user)
    if (isAdmin) {
      return NextResponse.json({ role: 'admin' })
    }
    const role = await getUserFacilityRole(db, user.id, id)
    return NextResponse.json({ role })
  } catch (error) {
    return apiError(toClientErrorMessage(error, 'ロールの取得に失敗しました'))
  }
}
