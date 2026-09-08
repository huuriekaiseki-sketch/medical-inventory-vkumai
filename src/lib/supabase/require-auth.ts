import type { SupabaseClient, User } from '@supabase/supabase-js'
import { recordAccessDenial } from '@/lib/security/access-denial'
import { consumeUserRequestQuota } from '@/lib/security/rate-limit'
import { withJudgmentTimeout } from '@/lib/security/judgment-timeout'

export async function requireAuth(db: SupabaseClient): Promise<User> {
  // WHY(#757-31): GoTrue を止めた実測で **54 秒**返らなかった。`auth.getUser()` は
  //      `.abortSignal()` を受け取れないので、**待つのをやめる**だけ（裏の要求は走り続ける）。
  //      上限を過ぎたら **user なし**で返し、下の `error || !user` に任せる
  //      （新しい分岐を足すと、そこだけ fail-closed が抜ける余地ができる）。
  //      諦めたこと自体は withJudgmentTimeout がログに残す。
  //      型を明示して広げるのは、`UserResponse` が「user がいる＋error なし」か
  //      「user が null ＋ error あり」のどちらかしか許さない形だから。
  //      諦めたときは「誰か分からない」だけで、Auth のエラーではない。
  const { data: { user }, error } = await withJudgmentTimeout<{
    data: { user: User | null }
    error: unknown
  }>(
    'auth.getUser',
    () => db.auth.getUser(),
    () => ({ data: { user: null }, error: null }),
  )
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
