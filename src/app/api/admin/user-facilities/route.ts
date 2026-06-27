import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase/server'
import { apiError } from '@/lib/api-error'

async function requireAdmin() {
  const db = await createServerSupabase()
  const { data: { user } } = await db.auth.getUser()
  const adminEmails = (process.env.ADMIN_EMAILS ?? '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  const email = user?.email?.trim().toLowerCase() ?? ''
  if (!user || !adminEmails.includes(email)) return null
  return user
}

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  let userId: string, facilityId: string
  try {
    const body = await request.json()
    userId = body.userId
    facilityId = body.facilityId
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!userId || !facilityId) return apiError('userId と facilityId は必須です', 400)

  const admin = createAdminSupabase()
  const { error } = await admin
    .from('user_facilities')
    .insert({ user_id: userId, facility_id: facilityId })
  if (error) return apiError(error.message)

  return NextResponse.json({ message: '施設を割り当てました' })
}

export async function DELETE(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  let userId: string, facilityId: string
  try {
    const body = await request.json()
    userId = body.userId
    facilityId = body.facilityId
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!userId || !facilityId) return apiError('userId と facilityId は必須です', 400)

  const admin = createAdminSupabase()
  const { error } = await admin
    .from('user_facilities')
    .delete()
    .eq('user_id', userId)
    .eq('facility_id', facilityId)
  if (error) return apiError(error.message)

  return NextResponse.json({ message: '施設の割り当てを解除しました' })
}
