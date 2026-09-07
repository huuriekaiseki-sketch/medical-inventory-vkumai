import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase } from '@/lib/supabase/server'
import { apiError, toClientErrorMessage } from '@/lib/api-error'
import { assertAdminAal2, requireAdmin } from '@/lib/admin-auth'
import { consumeInviteQuota, refundInviteQuota } from '@/lib/security/rate-limit'
import { asEnum } from '@/lib/mapping'
import type { AdminUser } from '@/types/admin'
import { FACILITY_ROLES, type FacilityRole } from '@/types/role'
import { parseBody } from '@/lib/validation/parse-body'
import { deleteUserSchema, inviteInputSchema } from '@/lib/validation/schemas'
import { recordPrivilegedOperation, toOperationErrorCode } from '@/lib/security/privileged-operation'

/**
 * 「メールが出ていないことが確実」と言えるか。
 *
 * WHY(status だけで判断し message を見ない): GoTrue の文言は版で変わるうえ、
 *      文字列一致は書き方を変えられると外れる。5xx は外部サービス側の失敗という
 *      種類の情報で、文言より安定している。status が無い（判断できない）ときは戻さない
 *      ＝**枠が減ったままになる側**へ倒す（多く戻すより、戻し過ぎない方が安全）。
 */
function isSendFailure(error: { status?: number } | null): boolean {
  return typeof error?.status === 'number' && error.status >= 500
}

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
  //
  // WHY(消費は送信より前・送れなかったときだけ戻す): 送ってしまったメールは取り消せないので、
  //      数えるのは必ず送信の前に置く。ただし M-021 の実測（2026-09-07、SMTP を止めて 3/3）で
  //      **GoTrue は送信に失敗すると利用者行ごとロールバックする**ことが分かり、
  //      残るのは消費済みの枠だけだった（メールは 1 通も出ないのに枠が減る）。
  //      2026-09-08 に人が「送信失敗だけ戻す」と決めたので、下の 5xx のときだけ払い戻す。
  const quota = await consumeInviteQuota(user.id)
  if (!quota.allowed) {
    return apiError('招待メールの 1 日の上限に達しました。明日以降にやり直してください', 429)
  }

  // WHY(W-011、実行直前の再確認): Supabase Auth の管理 API は service_role でしか呼べず、
  //      SQL の中に入れられないので RLS のトランザクションに統合できない
  //      （P-035 でやった「経路を無くす」が使えない唯一の場所）。
  //      隙間を消せないので、**送信の直前**でもう一度 admin と aal2 を確かめて窓を狭める。
  //      招待メールは送ってしまうと取り消せないので、確認は必ず送信より前に置く。
  if (!(await assertAdminAal2(user.id))) {
    return apiError('権限がありません（多要素認証が必要です）', 403)
  }

  const admin = createAdminSupabase()
  const { error } = await admin.auth.admin.inviteUserByEmail(email)

  // WHY(#757-24・39): 監査トリガーは public スキーマにしか付かず、GoTrue が持つ auth.users には
  //      届かない。2026-09-07 まで**成功した招待は 1 件も記録されていなかった**（弾かれた分だけが
  //      access_denials に残る非対称な状態で、「誰がいつ誰を招待したか」が追えなかった）。
  //      成功・失敗の両方を残す（失敗だけだと乗っ取り後に**通った**操作の範囲が分からない）。
  await recordPrivilegedOperation({
    operation: 'user_invite',
    succeeded: !error,
    actorId: user.id,
    targetEmail: email,
    errorCode: toOperationErrorCode(error),
  })

  if (error) {
    // WHY(2026-09-08 に人が決めた): 5xx は「GoTrue の中で送れなかった」＝メールが出ていないことが
    //      確実な場合。このときだけ枠を戻す。422（既に登録済み）などの利用者側の誤りは戻さない
    //      （戻すと同じ相手への連打が枠を消費しなくなり、上限が抑止として効かなくなる）。
    if (isSendFailure(error)) await refundInviteQuota(user.id)
    return apiError(toClientErrorMessage(error, '招待メールの送信に失敗しました'))
  }

  return NextResponse.json({ message: `${email} に招待メールを送信しました` })
}

export async function DELETE(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  const parsed = await parseBody(request, deleteUserSchema)
  if (!parsed.ok) return parsed.response
  const { userId } = parsed.data
  if (userId === user.id) return apiError('自分自身は削除できません', 400)

  // WHY(W-011、実行直前の再確認): 上と同じ理由。利用者の削除は元に戻せないので、
  //      判定から実行までの窓をできるだけ短くする。
  if (!(await assertAdminAal2(user.id))) {
    return apiError('権限がありません（多要素認証が必要です）', 403)
  }

  const admin = createAdminSupabase()
  const { error } = await admin.auth.admin.deleteUser(userId)

  // WHY: 上と同じ（#757-24・39）。削除は元に戻せないので、誰が誰を消したかは特に残す必要がある。
  await recordPrivilegedOperation({
    operation: 'user_delete',
    succeeded: !error,
    actorId: user.id,
    targetUserId: userId,
    errorCode: toOperationErrorCode(error),
  })

  if (error) return apiError(toClientErrorMessage(error, 'ユーザーの削除に失敗しました'))

  return NextResponse.json({ message: 'ユーザーを削除しました' })
}
