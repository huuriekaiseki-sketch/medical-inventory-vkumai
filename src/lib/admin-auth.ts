import { createServerSupabase } from '@/lib/supabase/server'

export async function requireAdmin() {
  const db = await createServerSupabase()
  const { data: { user } } = await db.auth.getUser()
  const adminEmails = (process.env.ADMIN_EMAILS ?? '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  const email = user?.email?.trim().toLowerCase() ?? ''
  if (!user || !adminEmails.includes(email)) return null
  return user
}
