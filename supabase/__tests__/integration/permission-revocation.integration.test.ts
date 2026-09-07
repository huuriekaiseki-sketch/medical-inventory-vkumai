// supabase/__tests__/integration/permission-revocation.integration.test.ts
// WHY: issue #757 の 27（権限の時間変化、P-023）。退職・所属変更・ロール降格・利用者削除のあと、
//      **サインインし直していない古い JWT** で何ができるかを実 DB で固定する。
//      認可は RLS / RPC が毎回 auth.uid() から user_facilities を引き直すので、所属を消した瞬間から
//      次のリクエストで効く（JWT の有効期限を待たない）。例外は JWT の user_role クレームで、
//      これはトークンが更新されるまで古い値のまま（UI ゲーティング専用。認可には使わない。
//      docs/agents/decisions/db-rls.md「なぜ JWT の user_role クレームを UI ゲーティング専用に限定したか」）。
//      その「古いまま」をここで実測して約束の境界値として書く。

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestSupabaseEnv } from '../../../e2e/env-guard'

const TEST_USER_PASSWORD = 'permission-revocation-test-0000'

function createServiceRoleClient(): SupabaseClient {
  assertTestSupabaseEnv()
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[permission-revocation] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。')
  }
  return createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

/** autoRefreshToken: false なので、サインイン時の JWT がテスト中ずっと使われる（古い JWT の再現） */
function createAnonClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
}

async function currentClaims(client: SupabaseClient): Promise<Record<string, unknown>> {
  const { data } = await client.auth.getSession()
  return decodeJwtPayload(data.session!.access_token)
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-023 権限の変更は次のリクエストから効く（古い JWT でも）
describe('権限の変更は古い JWT でも次のリクエストから効く [P-023]', () => {
  const runId = randomUUID()
  const serviceClient = createServiceRoleClient()
  const email = `permission-revocation-${runId}@example.test`

  let facilityId: string
  let userId: string
  /** サインイン時の JWT を持ち続ける client（トークン更新なし） */
  let staleClient: SupabaseClient

  const insertConsumable = (client: SupabaseClient, name: string) =>
    client.from('consumables').insert({ facility_id: facilityId, name, purpose: 'test' }).select('id').single()
  const selectConsumables = (client: SupabaseClient) =>
    client.from('consumables').select('id').eq('facility_id', facilityId)

  beforeAll(async () => {
    const { data: facility, error: facilityError } = await serviceClient
      .from('facilities')
      .insert({ name: `テスト施設-失効-${runId}` })
      .select('id')
      .single()
    if (facilityError || !facility) throw new Error(`施設作成失敗: ${facilityError?.message}`)
    facilityId = facility.id as string

    const { data: userData, error: userError } = await serviceClient.auth.admin.createUser({
      email,
      password: TEST_USER_PASSWORD,
      email_confirm: true,
    })
    if (userError || !userData.user) throw new Error(`ユーザー作成失敗: ${userError?.message}`)
    userId = userData.user.id

    const { error: linkError } = await serviceClient
      .from('user_facilities')
      .insert({ user_id: userId, facility_id: facilityId, role: 'staff' })
    if (linkError) throw new Error(`user_facilities作成失敗: ${linkError.message}`)

    staleClient = createAnonClient()
    const { error: signInError } = await staleClient.auth.signInWithPassword({ email, password: TEST_USER_PASSWORD })
    if (signInError) throw new Error(`サインイン失敗: ${signInError.message}`)
  }, 60_000)

  afterAll(async () => {
    // 利用者はテスト内で削除済みのことがある。施設の削除で user_facilities・consumables は CASCADE
    await serviceClient.auth.admin.deleteUser(userId).catch(() => undefined)
    await serviceClient.from('facilities').delete().eq('id', facilityId)
  })

  it('前提: staff としてサインインした JWT で書ける・読める。クレーム user_role は staff', async () => {
    const { error } = await insertConsumable(staleClient, '失効テスト（staff のとき）')
    expect(error).toBeNull()
    const { data: rows } = await selectConsumables(staleClient)
    expect(rows?.length).toBe(1)
    expect((await currentClaims(staleClient)).user_role).toBe('staff')
  })

  it('ロール降格（staff → viewer）は同じ JWT の次のリクエストから効く。書けなくなり、読みは残る', async () => {
    const { error: downgrade } = await serviceClient
      .from('user_facilities')
      .update({ role: 'viewer' })
      .eq('user_id', userId)
      .eq('facility_id', facilityId)
    expect(downgrade).toBeNull()

    const { error } = await insertConsumable(staleClient, '失効テスト（viewer のとき）')
    expect(error?.code).toBe('42501')
    const { data: rows } = await selectConsumables(staleClient)
    expect(rows?.length).toBe(1)

    // 境界値: JWT のクレームはトークンを更新するまで古いまま（UI ゲーティング専用。認可には使わない）
    expect((await currentClaims(staleClient)).user_role).toBe('staff')
  })

  it('所属の削除（退職・移籍）は同じ JWT の次のリクエストから効く。読みも消え、RPC は forbidden', async () => {
    const { error: unlink } = await serviceClient
      .from('user_facilities')
      .delete()
      .eq('user_id', userId)
      .eq('facility_id', facilityId)
    expect(unlink).toBeNull()

    const { data: rows, error: selectError } = await selectConsumables(staleClient)
    expect(selectError).toBeNull()
    expect(rows).toEqual([])

    const { data: member } = await staleClient.rpc('is_facility_member', { p_facility_id: facilityId })
    expect(member).toBe(false)

    const { error: rpcError } = await staleClient.rpc('create_loan_order_atomic', {
      p_facility_id: facilityId,
      p_procedure_name: '失効テスト',
      p_maker: 'テストメーカー',
      p_items: [],
    })
    expect(rpcError?.message).toContain('forbidden')
  })

  it('利用者の削除後、同じ JWT は getUser で拒否され、データも読めない', async () => {
    const { error: deleteError } = await serviceClient.auth.admin.deleteUser(userId)
    expect(deleteError).toBeNull()

    // getUser は Auth サーバーに問い合わせるので、削除は即座に効く（proxy の未認証ガード F-005 が /login へ送る）
    const { data: userData, error: getUserError } = await staleClient.auth.getUser()
    expect(getUserError).not.toBeNull()
    expect(userData.user).toBeNull()

    // PostgREST は JWT の署名しか見ないが、user_facilities は CASCADE で消えているので RLS が 0 行にする
    const { data: rows } = await selectConsumables(staleClient)
    expect(rows ?? []).toEqual([])
  })
})
