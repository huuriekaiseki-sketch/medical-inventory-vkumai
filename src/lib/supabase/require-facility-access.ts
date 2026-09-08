import type { SupabaseClient, User } from '@supabase/supabase-js'
import { resolveIsAdmin } from '@/lib/admin-status'
import { recordAccessDenial } from '@/lib/security/access-denial'
import { withJudgmentTimeout } from '@/lib/security/judgment-timeout'

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
    // WHY(#757-31): PostgREST を止めた実測で **55 秒**返らなかった 1 行。
    //      諦めたときは data なしで返し、下の `error || !data` がそのまま FORBIDDEN へ倒す
    const { data, error } = await withJudgmentTimeout<{ data: unknown; error: unknown }>(
      'rpc.is_facility_member',
      () => db.rpc('is_facility_member', { p_facility_id: facilityId }),
      () => ({ data: null, error: null }),
    )
    if (error || !data) {
      await recordAccessDenial({ guard: 'facility', reason: 'forbidden', actorId: user.id, facilityId })
      throw new Error('FORBIDDEN')
    }
  }
  return { facilityId }
}
