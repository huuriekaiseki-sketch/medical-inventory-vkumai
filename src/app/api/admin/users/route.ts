import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase } from '@/lib/supabase/server'
import { apiError } from '@/lib/api-error'
import { requireAdmin } from '@/lib/admin-auth'
import type { AdminUser } from '@/types/admin'

export async function GET() {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  const admin = createAdminSupabase()
  const { data, error } = await admin.auth.admin.listUsers()
  if (error) return apiError(error.message)

  const userIds = data.users.map(u => u.id)

  // Bulk fetch all facility assignments in one query
  const { data: facilityRows, error: facilityError } = await admin
    .from('user_facilities')
    .select('user_id, facility_id')
    .in('user_id', userIds)

  if (facilityError) return apiError(facilityError.message)

  // Group by user_id in memory
  const facilityMap = new Map<string, string[]>()
  for (const row of (facilityRows ?? [])) {
    const list = facilityMap.get(row.user_id) ?? []
    list.push(row.facility_id)
    facilityMap.set(row.user_id, list)
  }

  const users: AdminUser[] = data.users.map(u => ({
    id: u.id,
    email: u.email ?? '',
    lastSignInAt: u.last_sign_in_at ?? null,
    facilityIds: facilityMap.get(u.id) ?? [],
  }))

  return NextResponse.json({ users })
}

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  let email: string | undefined
  try {
    const body = await request.json()
    email = body.email?.trim()
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!email) return apiError('email は必須です', 400)

  const admin = createAdminSupabase()
  const { error } = await admin.auth.admin.inviteUserByEmail(email)
  if (error) return apiError(error.message)

  return NextResponse.json({ message: `${email} に招待メールを送信しました` })
}

export async function DELETE(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  let userId: string
  try {
    const body = await request.json()
    userId = body.userId
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!userId) return apiError('userId は必須です', 400)

  const admin = createAdminSupabase()
  const { error } = await admin.auth.admin.deleteUser(userId)
  if (error) return apiError(error.message)

  return NextResponse.json({ message: 'ユーザーを削除しました' })
}
