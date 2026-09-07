// WHY: admin判定ロジックをresolveIsAdmin()（src/lib/admin-status.ts）に一本化する。
//      SECURITY DEFINER RPC(get_admin_status)経由で判定するため、
//      createAdminSupabase()（Service Role Key）は不要になった。
import { createServerSupabase } from '@/lib/supabase/server'
import { resolveIsAdmin } from '@/lib/admin-status'
import { recordAccessDenial } from '@/lib/security/access-denial'

export async function requireAdmin() {
  const db = await createServerSupabase()
  // WHY(#757-31): getUser の error を捨てると、認証 API が落ちている間 fail-open になる。
  //      error があるときも未認証として扱う（fail-closed）。
  const { data: { user }, error } = await db.auth.getUser()
  if (error || !user) {
    // WHY(#757-24 P-063): admin 画面・admin API への未認証アクセスも証跡に残す
    await recordAccessDenial({ guard: 'admin', reason: 'unauthenticated' })
    return null
  }

  const isAdmin = await resolveIsAdmin(db, user)
  if (!isAdmin) {
    await recordAccessDenial({ guard: 'admin', reason: 'not_admin', actorId: user.id })
    return null
  }
  return user
}

/**
 * 特権操作の**直前**に、admin と aal2 をもう一度確かめる。
 *
 * WHY(2026-09-07、W-011): Supabase Auth の管理 API（利用者の作成・削除・招待）は
 *      service_role キーでしか呼べず、SQL の中に入れられない。つまり
 *      **RLS のトランザクションに統合できない**。P-035 で `user_facilities` にやった
 *      「経路そのものを無くす」が使えない唯一の場所。
 *
 *      隙間を消せないので、代わりに**狭める**。
 *        - `requireAdmin()` はハンドラの先頭で呼ぶ（早い 403 と拒否の記録のため）
 *        - これは**特権操作を呼ぶ直前**で呼ぶ（本文の読み取り・検証を挟んだ後）
 *      窓は「この確認から Auth API 呼び出しまで」に縮む。**ゼロにはならない。**
 *
 * WHY(aal2 も見る): `requireAdmin()` は aal2 を見ていない。マスタの書き込み（P-033）と
 *      権限の付け替え（P-035）は RLS が aal2 を要求するのに、Auth の管理 API だけが
 *      要求しないままだと、そこが迂回路になる。ここで揃える。
 *
 * `has_aal2()` は RLS ポリシーの中で `authenticated` が評価する関数なので、そのまま RPC で呼べる。
 * TOTP 未登録の利用者には TRUE を返すので、MFA を使っていない運用は変わらない。
 */
export async function assertAdminAal2(actorId: string): Promise<boolean> {
  const db = await createServerSupabase()

  // 1. admin かどうかをもう一度（先頭の判定からここまでの間に外されている可能性がある）
  const { data: { user }, error } = await db.auth.getUser()
  if (error || !user || user.id !== actorId) {
    await recordAccessDenial({ guard: 'admin', reason: 'unauthenticated', actorId })
    return false
  }
  if (!(await resolveIsAdmin(db, user))) {
    await recordAccessDenial({ guard: 'admin', reason: 'not_admin', actorId })
    return false
  }

  // 2. aal2 かどうか（RLS 経路と同じ判定を同じ関数で行う）
  const { data, error: aalError } = await db.rpc('has_aal2')
  // WHY(fail-closed): 判定できないときに通すと、確かめずに特権操作を実行することになる。
  //      拒否の記録も残す（黙って落とさない）。
  if (aalError || data !== true) {
    await recordAccessDenial({ guard: 'admin', reason: 'aal2_required', actorId })
    return false
  }
  return true
}
