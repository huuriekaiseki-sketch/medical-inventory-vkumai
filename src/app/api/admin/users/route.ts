import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase } from '@/lib/supabase/server'
import { apiError, toClientErrorMessage } from '@/lib/api-error'
import { requireAdmin } from '@/lib/admin-auth'
import { asEnum } from '@/lib/mapping'
import type { AdminUser } from '@/types/admin'
import { FACILITY_ROLES, type FacilityRole } from '@/types/role'

export async function GET() {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  const admin = createAdminSupabase()

  // WHY(#757-32): listUsers() は既定で 1 ページ 50 件しか返さない。51 人目からは
  //      画面にも API にも出ず、admin が「いないはずの利用者」を見落とす（2026-09-07 に
  //      60 人作って実測: 既定 50 件、perPage 指定で 60 件）。全ページを取り切る。
  //      PAGE_CAP は取り切れない量になったときの安全弁（そこまで増えたら一覧ではなく検索が要る）。
  const PER_PAGE = 1000
  const PAGE_CAP = 20
  type AuthUser = Awaited<ReturnType<typeof admin.auth.admin.listUsers>>['data']['users'][number]
  const users: AuthUser[] = []
  for (let page = 1; page <= PAGE_CAP; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE })
    if (error) return apiError(toClientErrorMessage(error, 'ユーザー一覧の取得に失敗しました'))
    users.push(...data.users)
    if (data.users.length < PER_PAGE) break
  }

  const userIds = users.map(u => u.id)

  // Bulk fetch all facility assignments in one query
  const { data: facilityRows, error: facilityError } = await admin
    .from('user_facilities')
    .select('user_id, facility_id, role')
    .in('user_id', userIds)

  if (facilityError) return apiError(toClientErrorMessage(facilityError, 'ユーザー一覧の取得に失敗しました'))

  // Group by user_id in memory
  const facilityMap = new Map<string, { id: string; role: FacilityRole }[]>()
  for (const row of (facilityRows ?? [])) {
    const list = facilityMap.get(row.user_id) ?? []
    list.push({ id: row.facility_id, role: asEnum(row.role, FACILITY_ROLES, 'staff') })
    facilityMap.set(row.user_id, list)
  }

  const result: AdminUser[] = users.map(u => ({
    id: u.id,
    email: u.email ?? '',
    lastSignInAt: u.last_sign_in_at ?? null,
    facilities: facilityMap.get(u.id) ?? [],
  }))

  return NextResponse.json({ users: result })
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
  if (error) return apiError(toClientErrorMessage(error, '招待メールの送信に失敗しました'))

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
  if (userId === user.id) return apiError('自分自身は削除できません', 400)

  const admin = createAdminSupabase()
  const { error } = await admin.auth.admin.deleteUser(userId)
  if (error) return apiError(toClientErrorMessage(error, 'ユーザーの削除に失敗しました'))

  return NextResponse.json({ message: 'ユーザーを削除しました' })
}
