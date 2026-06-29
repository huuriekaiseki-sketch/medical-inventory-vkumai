import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase } from '@/lib/supabase/server'
import { apiError } from '@/lib/api-error'
import { requireAdmin } from '@/lib/admin-auth'

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  let userId: string | undefined, facilityId: string | undefined, role: 'staff' | 'admin' | undefined
  try {
    const body = await request.json()
    userId = body.userId
    facilityId = body.facilityId
    role = body.role
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!userId || !facilityId) return apiError('userId と facilityId は必須です', 400)
  if (role !== undefined && role !== 'staff' && role !== 'admin') {
    return apiError("role は 'staff' か 'admin' のみ指定できます", 400)
  }

  const admin = createAdminSupabase()
  const { error } = await admin
    .from('user_facilities')
    .upsert(
      { user_id: userId, facility_id: facilityId, role: role ?? 'staff' },
      { onConflict: 'user_id,facility_id' }
    )

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
