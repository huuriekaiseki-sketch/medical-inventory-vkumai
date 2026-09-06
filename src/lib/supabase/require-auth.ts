import type { SupabaseClient, User } from '@supabase/supabase-js'
import { recordAccessDenial } from '@/lib/security/access-denial'

export async function requireAuth(db: SupabaseClient): Promise<User> {
  const { data: { user }, error } = await db.auth.getUser()
  if (error || !user) {
    // WHY(#757-24 P-063): 拒否は audit_log の行トリガーに来ないので、ここで残す。
    //      記録の失敗は握りつぶされる（recordAccessDenial 参照）ので、拒否の動作は変わらない
    await recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
    throw new Error('UNAUTHORIZED')
  }
  return user
}
