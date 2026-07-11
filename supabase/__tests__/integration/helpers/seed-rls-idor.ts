// supabase/__tests__/integration/helpers/seed-rls-idor.ts
// WHY: RLS/IDOR統合テスト(issue #165)用に、本物のローカルSupabaseへ
//      施設A・施設B、それぞれに所属するユーザーA・ユーザーB、施設Aに紐づく
//      loan_orders 1件を作成するヘルパー。ダミー名を使用し実在施設名は入れない
//      （docs/agents/common.md のデータ衛生ルール準拠）。
//      各テスト実行ごとに一意なメール・施設名を使うことで db reset 前提に
//      依存しすぎない設計にする（冪等性）。

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { assertTestSupabaseEnv } from '../../../../e2e/env-guard'

export interface SeededUser {
  id: string
  email: string
  /** ユーザー本人としてサインインした（JWT付きの）クライアント */
  client: SupabaseClient
}

export interface SeedRlsIdorFixtures {
  facilityA: { id: string; name: string }
  facilityB: { id: string; name: string }
  userA: SeededUser
  userB: SeededUser
  loanOrderA: { id: string }
}

// テスト用パスワード。ローカル/テスト専用DBでのみ使う使い捨て値のため機密情報ではない。
const TEST_USER_PASSWORD = 'rls-idor-test-password-0000'

function createServiceRoleClient(): SupabaseClient {
  // 本番Supabaseへの誤接続を防ぐ多層防御（globalSetupとの二重チェック）
  assertTestSupabaseEnv()

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      '[seed-rls-idor] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。' +
        '.env.test を設定してから実行してください。'
    )
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function createSignedInClient(
  serviceClient: SupabaseClient,
  email: string
): Promise<SupabaseClient> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!anonKey) {
    throw new Error('[seed-rls-idor] NEXT_PUBLIC_SUPABASE_ANON_KEY が未設定です。')
  }

  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { error } = await client.auth.signInWithPassword({
    email,
    password: TEST_USER_PASSWORD,
  })
  if (error) {
    throw new Error(`[seed-rls-idor] サインイン失敗 (${email}): ${error.message}`)
  }

  return client
}

async function createFacility(serviceClient: SupabaseClient, dummyName: string) {
  const { data, error } = await serviceClient
    .from('facilities')
    .insert({ name: dummyName })
    .select('id, name')
    .single()
  if (error || !data) {
    throw new Error(`[seed-rls-idor] 施設作成失敗 (${dummyName}): ${error?.message}`)
  }
  return { id: data.id as string, name: data.name as string }
}

async function createSeededUser(
  serviceClient: SupabaseClient,
  emailPrefix: string,
  facilityId: string
): Promise<SeededUser> {
  const email = `${emailPrefix}-${randomUUID()}@example.test`

  const { data, error } = await serviceClient.auth.admin.createUser({
    email,
    password: TEST_USER_PASSWORD,
    email_confirm: true,
  })
  if (error || !data.user) {
    throw new Error(`[seed-rls-idor] ユーザー作成失敗 (${email}): ${error?.message}`)
  }
  const userId = data.user.id

  const { error: linkError } = await serviceClient
    .from('user_facilities')
    .insert({ user_id: userId, facility_id: facilityId, role: 'staff' })
  if (linkError) {
    throw new Error(`[seed-rls-idor] user_facilities作成失敗 (${email}): ${linkError.message}`)
  }

  const client = await createSignedInClient(serviceClient, email)

  return { id: userId, email, client }
}

/**
 * 施設A・施設B、ユーザーA（施設Aのみ）・ユーザーB（施設Bのみ）、
 * 施設Aに紐づく loan_orders 1件を作成する。
 */
export async function seedRlsIdorFixtures(): Promise<SeedRlsIdorFixtures> {
  const serviceClient = createServiceRoleClient()
  const runId = randomUUID()

  const facilityA = await createFacility(serviceClient, `テスト施設A-${runId}`)
  const facilityB = await createFacility(serviceClient, `テスト施設B-${runId}`)

  const userA = await createSeededUser(serviceClient, 'rls-idor-user-a', facilityA.id)
  const userB = await createSeededUser(serviceClient, 'rls-idor-user-b', facilityB.id)

  // シード用の1件は service role client（RLSをバイパスする）で直接作成する。
  const { data: loanOrder, error: loanOrderError } = await serviceClient
    .from('loan_orders')
    .insert({
      facility_id: facilityA.id,
      procedure_name: 'シード用術式',
      maker: 'シード用メーカー',
    })
    .select('id')
    .single()
  if (loanOrderError || !loanOrder) {
    throw new Error(`[seed-rls-idor] loan_orders シード作成失敗: ${loanOrderError?.message}`)
  }

  return {
    facilityA,
    facilityB,
    userA,
    userB,
    loanOrderA: { id: loanOrder.id as string },
  }
}

/** シードしたユーザー・施設を後始末する（service role clientで直接削除） */
export async function cleanupRlsIdorFixtures(fixtures: SeedRlsIdorFixtures): Promise<void> {
  const serviceClient = createServiceRoleClient()

  // auth.users の削除は ON DELETE CASCADE で user_facilities も連動して消える。
  // facilities の削除は loan_orders 等を ON DELETE CASCADE で連動して消す。
  await serviceClient.auth.admin.deleteUser(fixtures.userA.id)
  await serviceClient.auth.admin.deleteUser(fixtures.userB.id)
  await serviceClient.from('facilities').delete().eq('id', fixtures.facilityA.id)
  await serviceClient.from('facilities').delete().eq('id', fixtures.facilityB.id)
}
