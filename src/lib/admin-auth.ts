// WHY: admin判定ロジックをresolveIsAdmin()（src/lib/admin-status.ts）に一本化する。
//      SECURITY DEFINER RPC(get_admin_status)経由で判定するため、
//      createAdminSupabase()（Service Role Key）は不要になった。
import { createServerSupabase } from '@/lib/supabase/server'
import { resolveIsAdmin } from '@/lib/admin-status'
import { recordAccessDenial } from '@/lib/security/access-denial'

export async function requireAdmin() {
  const db = await createServerSupabase()
  const { data: { user } } = await db.auth.getUser()
  if (!user) {
    // WHY(#757-24 P-063): admin 画面・admin API への未認証アクセスも証跡に残す
    await recordAccessDenial({ guard: 'admin', reason: 'unauthenticated' })
    return null
  }

  const isAdmin = await resolveIsAdmin(db, user)
  if (!isAdmin) {
    await recordAccessDenial({ guard: 'admin', reason: 'not_admin', actorId: user.id })
    return null
  }
  return user
}
