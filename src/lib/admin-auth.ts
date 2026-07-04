// WHY: admin判定ロジックをresolveIsAdmin()（src/lib/admin-status.ts）に一本化する。
//      SECURITY DEFINER RPC(get_admin_status)経由で判定するため、
//      createAdminSupabase()（Service Role Key）は不要になった。
import { createServerSupabase } from '@/lib/supabase/server'
import { resolveIsAdmin } from '@/lib/admin-status'

export async function requireAdmin() {
  const db = await createServerSupabase()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return null

  const isAdmin = await resolveIsAdmin(db, user)
  return isAdmin ? user : null
}
