// supabase/__tests__/integration/require-aal2-for-order-rpcs.integration.test.ts
// WHY: issue #612。発注RPCにaal2要求を追加した(20260806000001_require_aal2_for_order_rpcs.sql)。
//      「MFA未登録ユーザーは影響を受けない」だけでなく、本来の目的である「MFA登録済み
//      だがaal1のセッションは拒否され、aal2まで昇格したセッションは成功する」を、
//      実際のTOTP enroll→challenge→verifyフローで検証する。
//      TOTPコードはRFC 6238に基づきNode組み込みcryptoのみで生成し、新規npm依存
//      (otpauth等)を追加しない。

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestSupabaseEnv } from '../../../e2e/env-guard'
import { enrollAndVerifyTotp, signInAtAal1, stepUpToAal2 } from './helpers/mfa-totp'

const TEST_USER_PASSWORD = 'require-aal2-order-rpcs-test-0000'

function createServiceRoleClient(): SupabaseClient {
  assertTestSupabaseEnv()
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      '[require-aal2-for-order-rpcs] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。'
    )
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function createAnonClient(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-030 MFA 登録済みは aal2 が要る、未登録は aal1 で通る
describe('発注RPCはMFA登録済みユーザーのaal2昇格を要求する(issue #612) [P-030]', () => {
  const runId = randomUUID()
  const serviceClient = createServiceRoleClient()
  const email = `require-aal2-${runId}@example.test`

  let facilityId: string
  let userId: string
  let factorId: string
  let secret: string

  beforeAll(async () => {
    const { data: facility, error: facilityError } = await serviceClient
      .from('facilities')
      .insert({ name: `テスト施設-AAL2-${runId}` })
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
  }, 60_000)

  afterAll(async () => {
    await serviceClient.auth.admin.deleteUser(userId)
    await serviceClient.from('facilities').delete().eq('id', facilityId)
  })

  it('MFA未登録・aal1のセッションでは発注RPCが成功する(既存ユーザーへの回帰なし)', async () => {
    const client = createAnonClient()
    await signInAtAal1(client, email, TEST_USER_PASSWORD)

    const { error } = await client.rpc('create_loan_order_atomic', {
      p_facility_id: facilityId,
      p_procedure_name: 'aal2テスト術式(MFA未登録)',
      p_maker: 'テストメーカー',
      p_items: [],
    })
    expect(error).toBeNull()
  })

  it('TOTP factorをenroll・verifyできる(以降のテストの前提)', async () => {
    const client = createAnonClient()
    await signInAtAal1(client, email, TEST_USER_PASSWORD)

    const enrolled = await enrollAndVerifyTotp(client)
    factorId = enrolled.factorId
    secret = enrolled.secret
  }, 30_000)

  it('MFA登録済みだがaal1のセッションでは発注RPCがforbidden(aal2 required)で拒否される', async () => {
    // パスワードのみの再サインインは、factorが検証済みでも新規セッションはaal1から始まる
    // (src/proxy.ts（旧middleware.ts）のnextLevel判定と同じ挙動)
    const client = createAnonClient()
    await signInAtAal1(client, email, TEST_USER_PASSWORD)

    const { data: aal } = await client.auth.mfa.getAuthenticatorAssuranceLevel()
    expect(aal?.currentLevel).toBe('aal1')
    expect(aal?.nextLevel).toBe('aal2')

    const { error } = await client.rpc('create_loan_order_atomic', {
      p_facility_id: facilityId,
      p_procedure_name: 'aal2テスト術式(aal1で拒否)',
      p_maker: 'テストメーカー',
      p_items: [],
    })
    expect(error).not.toBeNull()
    expect(error?.message).toContain('aal2')
  })

  it('MFA登録済みでaal2まで昇格したセッションでは発注RPCが成功する', async () => {
    const client = createAnonClient()
    await signInAtAal1(client, email, TEST_USER_PASSWORD)
    await stepUpToAal2(client, factorId, secret)

    const { error } = await client.rpc('create_loan_order_atomic', {
      p_facility_id: facilityId,
      p_procedure_name: 'aal2テスト術式(aal2で成功)',
      p_maker: 'テストメーカー',
      p_items: [],
    })
    expect(error).toBeNull()
  })

  describe('残りの発注・返却RPC(create_case_order_atomic/create_consumable_order_atomic/create_loan_return_atomic、issue #684)', () => {
    it('create_case_order_atomicはaal1で拒否・aal2で成功する', async () => {
      const aal1Client = createAnonClient()
      await signInAtAal1(aal1Client, email, TEST_USER_PASSWORD)
      const { error: aal1Error } = await aal1Client.rpc('create_case_order_atomic', {
        p_facility_id: facilityId,
        p_case_datetime: new Date().toISOString(),
        p_procedure_name: 'aal2テスト術式(RPC-case)',
        p_patient_id: 'PT-RPC-1',
        p_patient_initials: 'R.P.',
        p_gender: 'other',
        p_doctor_name: 'RPCテスト医師',
        p_items: [],
      })
      expect(aal1Error).not.toBeNull()
      expect(aal1Error?.message).toContain('aal2')

      const aal2Client = createAnonClient()
      await signInAtAal1(aal2Client, email, TEST_USER_PASSWORD)
      await stepUpToAal2(aal2Client, factorId, secret)
      const { error: aal2Error } = await aal2Client.rpc('create_case_order_atomic', {
        p_facility_id: facilityId,
        p_case_datetime: new Date().toISOString(),
        p_procedure_name: 'aal2テスト術式(RPC-case)',
        p_patient_id: 'PT-RPC-2',
        p_patient_initials: 'R.P.',
        p_gender: 'other',
        p_doctor_name: 'RPCテスト医師',
        p_items: [],
      })
      expect(aal2Error).toBeNull()
    })

    it('create_consumable_order_atomicはaal1で拒否・aal2で成功する', async () => {
      const aal1Client = createAnonClient()
      await signInAtAal1(aal1Client, email, TEST_USER_PASSWORD)
      const { error: aal1Error } = await aal1Client.rpc('create_consumable_order_atomic', {
        p_facility_id: facilityId,
        p_items: [],
      })
      expect(aal1Error).not.toBeNull()
      expect(aal1Error?.message).toContain('aal2')

      const aal2Client = createAnonClient()
      await signInAtAal1(aal2Client, email, TEST_USER_PASSWORD)
      await stepUpToAal2(aal2Client, factorId, secret)
      const { error: aal2Error } = await aal2Client.rpc('create_consumable_order_atomic', {
        p_facility_id: facilityId,
        p_items: [],
      })
      expect(aal2Error).toBeNull()
    })

    it('create_loan_return_atomicはaal1で拒否・aal2で成功する', async () => {
      const aal1Client = createAnonClient()
      await signInAtAal1(aal1Client, email, TEST_USER_PASSWORD)
      const { error: aal1Error } = await aal1Client.rpc('create_loan_return_atomic', {
        p_header: { facility_id: facilityId, return_datetime: new Date().toISOString() },
        p_items: [],
      })
      expect(aal1Error).not.toBeNull()
      expect(aal1Error?.message).toContain('aal2')

      const aal2Client = createAnonClient()
      await signInAtAal1(aal2Client, email, TEST_USER_PASSWORD)
      await stepUpToAal2(aal2Client, factorId, secret)
      const { error: aal2Error } = await aal2Client.rpc('create_loan_return_atomic', {
        p_header: { facility_id: facilityId, return_datetime: new Date().toISOString() },
        p_items: [],
      })
      expect(aal2Error).toBeNull()
    })
  })
})
