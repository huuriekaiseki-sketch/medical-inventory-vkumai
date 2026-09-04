// supabase/__tests__/integration/rbac-viewer-role.integration.test.ts
// WHY: 20260805000001_add_viewer_role.sqlはuser_facilities.roleに'viewer'を追加し、
//      「書き込み全般不可・閲覧のみ」という認可境界を新設した。RLSポリシー分割と
//      発注系RPCの認可チェック変更(is_facility_member→is_facility_writer)を
//      実DBで検証する。既存のRLS/IDOR統合テストはテナント境界(他施設)のみを
//      検証しており、同一施設内のrole差分(staff/admin vs viewer)は未カバーだった。

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestSupabaseEnv } from '../../../e2e/env-guard'

const TEST_USER_PASSWORD = 'rbac-viewer-role-test-0000'

function createServiceRoleClient(): SupabaseClient {
  assertTestSupabaseEnv()
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      '[rbac-viewer-role] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。'
    )
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function createSignedInClient(
  serviceClient: SupabaseClient,
  facilityId: string,
  role: 'staff' | 'admin' | 'viewer',
  runId: string
): Promise<SupabaseClient> {
  const email = `rbac-viewer-role-${role}-${runId}@example.test`
  const { data: userData, error: userError } = await serviceClient.auth.admin.createUser({
    email,
    password: TEST_USER_PASSWORD,
    email_confirm: true,
  })
  if (userError || !userData.user) {
    throw new Error(`ユーザー作成失敗(${role}): ${userError?.message}`)
  }

  const { error: linkError } = await serviceClient
    .from('user_facilities')
    .insert({ user_id: userData.user.id, facility_id: facilityId, role })
  if (linkError) {
    throw new Error(`user_facilities作成失敗(${role}): ${linkError.message}`)
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: TEST_USER_PASSWORD })
  if (signInError) {
    throw new Error(`サインイン失敗(${role}): ${signInError.message}`)
  }
  return client
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-020 viewer は閲覧のみ
describe('viewerロールは書き込み不可・閲覧のみ(issue: RBAC拡張) [P-020]', () => {
  const runId = randomUUID()
  const serviceClient = createServiceRoleClient()

  let facilityId: string
  let viewerClient: SupabaseClient
  let staffClient: SupabaseClient
  let viewerUserId: string
  let staffUserId: string

  beforeAll(async () => {
    const { data: facility, error: facilityError } = await serviceClient
      .from('facilities')
      .insert({ name: `テスト施設-RBAC-${runId}` })
      .select('id')
      .single()
    if (facilityError || !facility) {
      throw new Error(`施設作成失敗: ${facilityError?.message}`)
    }
    facilityId = facility.id as string

    viewerClient = await createSignedInClient(serviceClient, facilityId, 'viewer', runId)
    staffClient = await createSignedInClient(serviceClient, facilityId, 'staff', runId)

    const { data: viewerUser } = await serviceClient.auth.admin.listUsers()
    viewerUserId = viewerUser.users.find((u) => u.email?.startsWith('rbac-viewer-role-viewer'))!.id
    staffUserId = viewerUser.users.find((u) => u.email?.startsWith('rbac-viewer-role-staff'))!.id
  }, 60_000)

  afterAll(async () => {
    await serviceClient.auth.admin.deleteUser(viewerUserId)
    await serviceClient.auth.admin.deleteUser(staffUserId)
    await serviceClient.from('facilities').delete().eq('id', facilityId)
  })

  it('viewerはSELECTできる(consumables)', async () => {
    const { error } = await viewerClient.from('consumables').select('id').eq('facility_id', facilityId)
    expect(error).toBeNull()
  })

  it('viewerはconsumablesへのINSERTがRLSで拒否される', async () => {
    const { error } = await viewerClient
      .from('consumables')
      .insert({ facility_id: facilityId, name: 'viewer-insert-test', purpose: 'テスト' })
    expect(error).not.toBeNull()
  })

  it('viewerはcreate_case_order_atomic RPCがforbiddenで拒否される', async () => {
    const { error } = await viewerClient.rpc('create_case_order_atomic', {
      p_facility_id: facilityId,
      p_case_datetime: new Date().toISOString(),
      p_procedure_name: 'viewerテスト術式',
      p_patient_id: 'PT-VIEWER',
      p_patient_initials: 'V.V.',
      p_gender: 'other',
      p_doctor_name: 'viewerテスト医師',
      p_items: [],
    })
    expect(error).not.toBeNull()
    expect(error?.message).toContain('forbidden')
  })

  it('viewerはcreate_loan_order_atomic RPCがforbiddenで拒否される', async () => {
    const { error } = await viewerClient.rpc('create_loan_order_atomic', {
      p_facility_id: facilityId,
      p_procedure_name: 'viewerテスト術式',
      p_maker: 'viewerテストメーカー',
      p_items: [],
    })
    expect(error).not.toBeNull()
    expect(error?.message).toContain('forbidden')
  })

  it('viewerはcreate_consumable_order_atomic RPCがforbiddenで拒否される', async () => {
    const { error } = await viewerClient.rpc('create_consumable_order_atomic', {
      p_facility_id: facilityId,
      p_items: [],
    })
    expect(error).not.toBeNull()
    expect(error?.message).toContain('forbidden')
  })

  it('staffは同じ施設でconsumablesへのINSERTが成功する(回帰確認)', async () => {
    const { error } = await staffClient
      .from('consumables')
      .insert({ facility_id: facilityId, name: 'staff-insert-test', purpose: 'テスト' })
    expect(error).toBeNull()
  })

  it('staffは同じ施設でcreate_loan_order_atomic RPCが成功する(回帰確認)', async () => {
    const { error } = await staffClient.rpc('create_loan_order_atomic', {
      p_facility_id: facilityId,
      p_procedure_name: 'staffテスト術式',
      p_maker: 'staffテストメーカー',
      p_items: [],
    })
    expect(error).toBeNull()
  })
})
