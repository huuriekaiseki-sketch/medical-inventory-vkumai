import type { SupabaseClient, User } from '@supabase/supabase-js'

function isAdminUser(user: User): boolean {
  const adminEmails = (process.env.ADMIN_EMAILS ?? '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  return adminEmails.includes(user.email?.trim().toLowerCase() ?? '')
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
  const admin = isAdminUser(user)
  if (!admin) {
    if (!facilityId) throw new Error('FACILITY_ID_REQUIRED')
    const { data, error } = await db.rpc('is_facility_member', { p_facility_id: facilityId })
    if (error || !data) throw new Error('FORBIDDEN')
  }
  return { facilityId }
}
