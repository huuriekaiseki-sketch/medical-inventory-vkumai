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

  const users: AdminUser[] = await Promise.all(
    data.users.map(async (u) => {
      const { data: rows } = await admin
        .from('user_facilities')
        .select('facility_id')
        .eq('user_id', u.id)
      return {
        id: u.id,
        email: u.email ?? '',
        lastSignInAt: u.last_sign_in_at ?? null,
        facilityIds: (rows ?? []).map((r: { facility_id: string }) => r.facility_id),
      }
    })
  )
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
