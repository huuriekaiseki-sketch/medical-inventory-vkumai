import type { SupabaseClient, User } from '@supabase/supabase-js'
import { createAdminSupabase } from '@/lib/supabase/server'

// WHY: requireAdmin()（admin-auth.ts）と同じロジック。
//      requireFacilityAccess で使うため User オブジェクト版を持つ。
async function isAdminUserWithEmail(user: User): Promise<boolean> {
  const adminDb = createAdminSupabase()

  const { data: userAdminRows } = await adminDb
    .from('user_facilities')
    .select('user_id, role')
    .eq('user_id', user.id)
    .eq('role', 'admin')
    .limit(1)

  if (userAdminRows && userAdminRows.length > 0) {
    return true
  }

  const { data: anyAdminRows } = await adminDb
    .from('user_facilities')
    .select('role')
    .eq('role', 'admin')
    .limit(1)

  const dbHasAdmin = anyAdminRows && anyAdminRows.length > 0
  if (dbHasAdmin) {
    return false
  }

  // フォールバック: ADMIN_EMAILSチェック
  const adminEmails = (process.env.ADMIN_EMAILS ?? '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  const email = user.email?.trim().toLowerCase() ?? ''
  return adminEmails.includes(email)
}

// facilityId が null の場合:
//   admin → 全施設アクセス許可
//   非admin → Error('FACILITY_ID_REQUIRED')
// facilityId が指定された場合:
//   admin → そのまま通す
//   非admin → is_facility_member RPC で確認、非メンバーは Error('FORBIDDEN')
export async function requireFacilityAccess(
  db: SupabaseClient,
  user: User,
  facilityId: string | null
): Promise<{ facilityId: string | null }> {
  const admin = await isAdminUserWithEmail(user)
  if (!admin) {
    if (!facilityId) throw new Error('FACILITY_ID_REQUIRED')
    const { data, error } = await db.rpc('is_facility_member', { p_facility_id: facilityId })
    if (error || !data) throw new Error('FORBIDDEN')
  }
  return { facilityId }
}
