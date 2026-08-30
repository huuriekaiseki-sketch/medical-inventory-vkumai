// WHY: requireAdmin()(admin-auth.ts)とrequireFacilityAccess()(require-facility-access.ts)、
//      proxy.ts（旧middleware.ts）が別々に実装していた「①自分がrole='admin'か→②DB全体にadminが
//      1件でもいるか（いれば非admin確定）→③いなければADMIN_EMAILSフォールバック」という
//      admin判定ロジックを一本化する。
//      SECURITY DEFINER RPC(get_admin_status)を使うことで、Edge Runtime(proxy.ts)でも
//      service role keyなしにRLSをバイパスして①②を判定できる。
//      ADMIN_EMAILSはPostgres側から読めないため、③のフォールバック判定のみTS側に残す。
import type { SupabaseClient, User } from '@supabase/supabase-js'

interface AdminStatusRow {
  user_is_admin: boolean
  db_has_admin: boolean
}

export async function resolveIsAdmin(db: SupabaseClient, user: User): Promise<boolean> {
  const { data, error } = await db.rpc('get_admin_status')
  if (error || !data || (data as AdminStatusRow[]).length === 0) return false

  const { user_is_admin, db_has_admin } = (data as AdminStatusRow[])[0]
  if (user_is_admin) return true
  if (db_has_admin) return false

  const adminEmails = (process.env.ADMIN_EMAILS ?? '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  if (adminEmails.length === 0) return false

  return adminEmails.includes((user.email ?? '').trim().toLowerCase())
}
