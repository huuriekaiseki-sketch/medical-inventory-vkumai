import type { SupabaseClient, User } from '@supabase/supabase-js'

export async function requireAuth(db: SupabaseClient): Promise<User> {
  const { data: { user }, error } = await db.auth.getUser()
  if (error || !user) throw new Error('UNAUTHORIZED')
  return user
}
