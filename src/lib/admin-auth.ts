// WHY: admin判定をDB roleベースに統一する。
//      ADMIN_EMAILSはフォールバックとしてDBにadminが0件の場合のみ使用。
//      createAdminSupabase()でRLSをバイパスしてuser_facilitiesを検索する。
import { createServerSupabase, createAdminSupabase } from '@/lib/supabase/server'

export async function requireAdmin() {
  const db = await createServerSupabase()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return null

  const adminDb = createAdminSupabase()

  // ユーザーがrole='admin'を持つかDBで確認
  const { data: userAdminRows } = await adminDb
    .from('user_facilities')
    .select('user_id, role')
    .eq('user_id', user.id)
    .eq('role', 'admin')
    .limit(1)

  if (userAdminRows && userAdminRows.length > 0) {
    return user
  }

  // DBにadminが1件もいるか確認（フォールバック用）
  const { data: anyAdminRows } = await adminDb
    .from('user_facilities')
    .select('role')
    .eq('role', 'admin')
    .limit(1)

  const dbHasAdmin = anyAdminRows && anyAdminRows.length > 0
  if (dbHasAdmin) {
    // DBにadminがいる → このユーザーはadminでない
    return null
  }

  // DBにadminが0件 → ADMIN_EMAILSフォールバック
  const adminEmails = (process.env.ADMIN_EMAILS ?? '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)

  if (adminEmails.length === 0) {
    // ADMIN_EMAILSも未設定
    return null
  }

  const email = user.email?.trim().toLowerCase() ?? ''
  if (adminEmails.includes(email)) {
    return user
  }

  return null
}
