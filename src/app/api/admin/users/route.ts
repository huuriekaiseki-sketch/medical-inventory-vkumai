import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase } from '@/lib/supabase/server'
import { apiError, toClientErrorMessage } from '@/lib/api-error'
import { requireAdmin } from '@/lib/admin-auth'
import { consumeInviteQuota } from '@/lib/security/rate-limit'
import { asEnum } from '@/lib/mapping'
import type { AdminUser } from '@/types/admin'
import { FACILITY_ROLES, type FacilityRole } from '@/types/role'
import { parseBody } from '@/lib/validation/parse-body'
import { deleteUserSchema, inviteInputSchema } from '@/lib/validation/schemas'

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

  const parsed = await parseBody(request, inviteInputSchema)
  if (!parsed.ok) return parsed.response
  const { email } = parsed.data

  // WHY(#757-32 Q-020): 招待メールは外に出ていく唯一の経路で、従量課金と迷惑メール判定の
  //      対象。2026-09-07 の点検では 8 通を連続で送れた（止まる仕組みが無かった）。
  //      上限は人が決めた値（aidd.config.json の limits.invitesPerDay = 管理者 1 人あたり
  //      毎日 50 通）。超えたら送らずに 429 を返し、access_denials に残す。
  const quota = await consumeInviteQuota(user.id)
  if (!quota.allowed) {
    return apiError('招待メールの 1 日の上限に達しました。明日以降にやり直してください', 429)
  }

  const admin = createAdminSupabase()
  const { error } = await admin.auth.admin.inviteUserByEmail(email)
  if (error) return apiError(toClientErrorMessage(error, '招待メールの送信に失敗しました'))

  return NextResponse.json({ message: `${email} に招待メールを送信しました` })
}

export async function DELETE(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  const parsed = await parseBody(request, deleteUserSchema)
  if (!parsed.ok) return parsed.response
  const { userId } = parsed.data
  if (userId === user.id) return apiError('自分自身は削除できません', 400)

  const admin = createAdminSupabase()
  const { error } = await admin.auth.admin.deleteUser(userId)
  if (error) return apiError(toClientErrorMessage(error, 'ユーザーの削除に失敗しました'))

  return NextResponse.json({ message: 'ユーザーを削除しました' })
}
