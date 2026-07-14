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

export function createServiceRoleClient(): SupabaseClient {
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

export async function createFacility(serviceClient: SupabaseClient, dummyName: string) {
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

export async function createSeededUser(
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

/**
 * ユーザーA・B、施設A・Bを後始末する共通処理（issue #315: loan_orders専用だった
 * cleanupRlsIdorFixturesから、case_orders/consumable_orders版でも再利用できるよう切り出した）。
 * auth.usersの削除はON DELETE CASCADEでuser_facilitiesも連動して消える。
 * facilitiesの削除はloan_orders/case_orders/consumable_orders等を
 * ON DELETE CASCADEで連動して消す。
 */
export async function cleanupFacilitiesAndUsers(
  userA: SeededUser,
  userB: SeededUser,
  facilityA: { id: string },
  facilityB: { id: string }
): Promise<void> {
  const serviceClient = createServiceRoleClient()

  await serviceClient.auth.admin.deleteUser(userA.id)
  await serviceClient.auth.admin.deleteUser(userB.id)
  await serviceClient.from('facilities').delete().eq('id', facilityA.id)
  await serviceClient.from('facilities').delete().eq('id', facilityB.id)
}

/** シードしたユーザー・施設を後始末する（service role clientで直接削除） */
export async function cleanupRlsIdorFixtures(fixtures: SeedRlsIdorFixtures): Promise<void> {
  await cleanupFacilitiesAndUsers(fixtures.userA, fixtures.userB, fixtures.facilityA, fixtures.facilityB)
}

export interface SeedCaseOrdersRlsIdorFixtures {
  facilityA: { id: string; name: string }
  facilityB: { id: string; name: string }
  userA: SeededUser
  userB: SeededUser
  caseOrderA: { id: string }
}

/**
 * 施設A・施設B、ユーザーA（施設Aのみ）・ユーザーB（施設Bのみ）、
 * 施設Aに紐づく case_orders 1件を作成する（issue #315: loan_ordersと同様の横展開）。
 */
export async function seedCaseOrdersRlsIdorFixtures(): Promise<SeedCaseOrdersRlsIdorFixtures> {
  const serviceClient = createServiceRoleClient()
  const runId = randomUUID()

  const facilityA = await createFacility(serviceClient, `テスト施設A-${runId}`)
  const facilityB = await createFacility(serviceClient, `テスト施設B-${runId}`)

  const userA = await createSeededUser(serviceClient, 'rls-idor-case-user-a', facilityA.id)
  const userB = await createSeededUser(serviceClient, 'rls-idor-case-user-b', facilityB.id)

  const { data: caseOrder, error: caseOrderError } = await serviceClient
    .from('case_orders')
    .insert({
      facility_id: facilityA.id,
      case_datetime: new Date().toISOString(),
      procedure_name: 'シード用術式',
      patient_id: 'IDOR-TEST-PATIENT-0000',
      patient_initials: 'IDORテスト患者',
      gender: 'other',
      doctor_name: 'IDORテスト医師',
    })
    .select('id')
    .single()
  if (caseOrderError || !caseOrder) {
    throw new Error(`[seed-rls-idor] case_orders シード作成失敗: ${caseOrderError?.message}`)
  }

  return {
    facilityA,
    facilityB,
    userA,
    userB,
    caseOrderA: { id: caseOrder.id as string },
  }
}

export async function cleanupCaseOrdersRlsIdorFixtures(fixtures: SeedCaseOrdersRlsIdorFixtures): Promise<void> {
  await cleanupFacilitiesAndUsers(fixtures.userA, fixtures.userB, fixtures.facilityA, fixtures.facilityB)
}

export interface SeedConsumableOrdersRlsIdorFixtures {
  facilityA: { id: string; name: string }
  facilityB: { id: string; name: string }
  userA: SeededUser
  userB: SeededUser
  consumableOrderA: { id: string }
}

/**
 * 施設A・施設B、ユーザーA（施設Aのみ）・ユーザーB（施設Bのみ）、
 * 施設Aに紐づく consumable_orders 1件を作成する（issue #315: loan_ordersと同様の横展開）。
 */
export async function seedConsumableOrdersRlsIdorFixtures(): Promise<SeedConsumableOrdersRlsIdorFixtures> {
  const serviceClient = createServiceRoleClient()
  const runId = randomUUID()

  const facilityA = await createFacility(serviceClient, `テスト施設A-${runId}`)
  const facilityB = await createFacility(serviceClient, `テスト施設B-${runId}`)

  const userA = await createSeededUser(serviceClient, 'rls-idor-consumable-user-a', facilityA.id)
  const userB = await createSeededUser(serviceClient, 'rls-idor-consumable-user-b', facilityB.id)

  const { data: consumableOrder, error: consumableOrderError } = await serviceClient
    .from('consumable_orders')
    .insert({ facility_id: facilityA.id })
    .select('id')
    .single()
  if (consumableOrderError || !consumableOrder) {
    throw new Error(`[seed-rls-idor] consumable_orders シード作成失敗: ${consumableOrderError?.message}`)
  }

  return {
    facilityA,
    facilityB,
    userA,
    userB,
    consumableOrderA: { id: consumableOrder.id as string },
  }
}

export async function cleanupConsumableOrdersRlsIdorFixtures(fixtures: SeedConsumableOrdersRlsIdorFixtures): Promise<void> {
  await cleanupFacilitiesAndUsers(fixtures.userA, fixtures.userB, fixtures.facilityA, fixtures.facilityB)
}

export interface SeedOrdersRlsIdorFixtures {
  facilityA: { id: string; name: string }
  facilityB: { id: string; name: string }
  userA: SeededUser
  userB: SeededUser
  caseOrderA: { id: string }
  consumableOrderA: { id: string }
  loanOrderA: { id: string }
  loanReturnA: { id: string }
}

/**
 * 施設A・施設B、ユーザーA（施設Aのみ）・ユーザーB（施設Bのみ）、施設Aに紐づく
 * 4種別発注（case_orders/consumable_orders/loan_orders/loan_returns）1件ずつを作成する
 * （issue #20: /orders 横断一覧の「自施設の発注のみが表示される」受け入れ条件を、
 * 個別テーブルのRLSではなく listOrders() 経由で確認するための統合テスト用フィクスチャ）。
 */
export async function seedOrdersRlsIdorFixtures(): Promise<SeedOrdersRlsIdorFixtures> {
  const serviceClient = createServiceRoleClient()
  const runId = randomUUID()

  const facilityA = await createFacility(serviceClient, `テスト施設A-${runId}`)
  const facilityB = await createFacility(serviceClient, `テスト施設B-${runId}`)

  const userA = await createSeededUser(serviceClient, 'rls-idor-orders-user-a', facilityA.id)
  const userB = await createSeededUser(serviceClient, 'rls-idor-orders-user-b', facilityB.id)

  const { data: caseOrder, error: caseOrderError } = await serviceClient
    .from('case_orders')
    .insert({
      facility_id: facilityA.id,
      case_datetime: new Date().toISOString(),
      procedure_name: 'シード用術式',
      patient_id: 'IDOR-TEST-PATIENT-0000',
      patient_initials: 'IDORテスト患者',
      gender: 'other',
      doctor_name: 'IDORテスト医師',
    })
    .select('id')
    .single()
  if (caseOrderError || !caseOrder) {
    throw new Error(`[seed-rls-idor] case_orders シード作成失敗: ${caseOrderError?.message}`)
  }

  const { data: consumableOrder, error: consumableOrderError } = await serviceClient
    .from('consumable_orders')
    .insert({ facility_id: facilityA.id })
    .select('id')
    .single()
  if (consumableOrderError || !consumableOrder) {
    throw new Error(`[seed-rls-idor] consumable_orders シード作成失敗: ${consumableOrderError?.message}`)
  }

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

  const { data: loanReturn, error: loanReturnError } = await serviceClient
    .from('loan_returns')
    .insert({ facility_id: facilityA.id, return_datetime: new Date().toISOString() })
    .select('id')
    .single()
  if (loanReturnError || !loanReturn) {
    throw new Error(`[seed-rls-idor] loan_returns シード作成失敗: ${loanReturnError?.message}`)
  }

  return {
    facilityA,
    facilityB,
    userA,
    userB,
    caseOrderA: { id: caseOrder.id as string },
    consumableOrderA: { id: consumableOrder.id as string },
    loanOrderA: { id: loanOrder.id as string },
    loanReturnA: { id: loanReturn.id as string },
  }
}

export async function cleanupOrdersRlsIdorFixtures(fixtures: SeedOrdersRlsIdorFixtures): Promise<void> {
  await cleanupFacilitiesAndUsers(fixtures.userA, fixtures.userB, fixtures.facilityA, fixtures.facilityB)
}
