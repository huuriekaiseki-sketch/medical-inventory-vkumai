import type { SupabaseClient, User } from '@supabase/supabase-js'
import { resolveIsAdmin } from '@/lib/admin-status'
import { recordAccessDenial } from '@/lib/security/access-denial'

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
  const admin = await resolveIsAdmin(db, user)
  if (!admin) {
    if (!facilityId) {
      // WHY(#757-24 P-063): 施設 ID 無しでの横断アクセスの試行も残す（総当たりの前触れになる）
      await recordAccessDenial({ guard: 'facility', reason: 'facility_id_required', actorId: user.id })
      throw new Error('FACILITY_ID_REQUIRED')
    }
    const { data, error } = await db.rpc('is_facility_member', { p_facility_id: facilityId })
    if (error || !data) {
      await recordAccessDenial({ guard: 'facility', reason: 'forbidden', actorId: user.id, facilityId })
      throw new Error('FORBIDDEN')
    }
  }
  return { facilityId }
}
