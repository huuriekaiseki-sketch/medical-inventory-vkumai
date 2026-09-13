import type { SupabaseClient, User } from '@supabase/supabase-js'
import { resolveIsAdmin } from '@/lib/admin-status'
import { recordAccessDenial } from '@/lib/security/access-denial'
import { withJudgmentTimeout } from '@/lib/security/judgment-timeout'

// facilityId が null の場合:
//   admin → 全施設アクセス許可（options.facilityIdRequired なら Error('FACILITY_ID_REQUIRED')）
//   非admin → Error('FACILITY_ID_REQUIRED')
// facilityId が指定された場合:
//   admin → そのまま通す
//   非admin → is_facility_member RPC で確認、非メンバーは Error('FORBIDDEN')
//
// WHY(facilityIdRequired、2026-09-13 の実測): 一覧 GET 5 本（case-orders / loan-orders /
//      consumable-orders / loan-returns / consumables）は repository が facility_id で絞る前提なのに、
//      admin が facility_id を付けないとここを通り、`.eq('facility_id', undefined)` が PostgREST の
//      uuid 変換で 500 になっていた（同じ状況で /api/orders は 400、hospital-prices は 200 と不揃い）。
//      「admin は施設指定なしでも通る」（P-002）は hospital-prices / news の契約として残し、
//      施設で絞ることが前提の route だけがこのオプションで必須にする。判定を route に散らさず
//      ここに置く（唯一の入口）。admin の付け忘れは拒否ではないので access_denials には残さない
export interface RequireFacilityAccessOptions {
  facilityIdRequired?: boolean
}

export async function requireFacilityAccess(
  db: SupabaseClient,
  user: User,
  facilityId: string | null,
  options: RequireFacilityAccessOptions = {}
): Promise<{ facilityId: string | null }> {
  const admin = await resolveIsAdmin(db, user)
  if (admin && options.facilityIdRequired && !facilityId) {
    throw new Error('FACILITY_ID_REQUIRED')
  }
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
