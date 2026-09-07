import type { SupabaseClient, User } from '@supabase/supabase-js'
import { recordAccessDenial } from '@/lib/security/access-denial'
import { consumeUserRequestQuota } from '@/lib/security/rate-limit'

export async function requireAuth(db: SupabaseClient): Promise<User> {
  const { data: { user }, error } = await db.auth.getUser()
  if (error || !user) {
    // WHY(#757-24 P-063): 拒否は audit_log の行トリガーに来ないので、ここで残す。
    //      記録の失敗は握りつぶされる（recordAccessDenial 参照）ので、拒否の動作は変わらない
    await recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
    throw new Error('UNAUTHORIZED')
  }

  // WHY(#757-32 Q-002): 回数の上限をここで数える。requireAuth は API の 24 route すべてが
  //      通る唯一の場所なので、ここに置けば新しい route が上限を忘れることがない
  //      （route ごとに書くと、必ずどれかが抜ける）。
  //      上限は人が決めた値（aidd.config.json の limits.requestsPerMinute = 毎分 300 回）。
  //      数えられないとき（DB に届かない・環境変数が無い）は通す（fail-open）。
  const quota = await consumeUserRequestQuota(user.id)
  if (!quota.allowed) throw new Error('RATE_LIMITED')

  return user
}
