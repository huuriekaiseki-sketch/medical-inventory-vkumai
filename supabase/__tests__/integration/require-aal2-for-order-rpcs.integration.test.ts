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
import { describeDenial, isPermissionDenied } from './helpers/pg-error'

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

  // WHY(#757-7, RM-002): 2026-09-07 に RLS を壊して測ったところ、
  //      **facility_writer_or_admin から has_aal2() を外しても、このファイルは 1 つも落ちなかった**。
  //      理由は、ここが RPC 経由しか見ていなかったから。RPC は関数の中にも aal2 の判定を持つので、
  //      RLS 側を外しても RPC の挙動は変わらない。
  //      **表を直接叩く経路は RLS だけが守る。**ここを見ていないと、RLS の aal2 は
  //      いつ消えても誰も気づかない。
  // WHY(2026-09-09 に測る対象を移した): 発注の表への**直接 INSERT の道そのものを無くした**
  //      （20260909040000）。以前はここで「aal1 は拒否・aal2 なら通る」を測って
  //      「拒否が aal2 由来である」ことの対照にしていたが、いまの拒否は**権限由来**なので
  //      同じ書き方では対照にならない（C-023: 手前の防御が止めていて狙った防御を測れない）。
  //
  //      対照は `consumables` へ移す。この表は**アプリが直接書く**ので INSERT の権限が残っており、
  //      `facility_writer_or_admin` の `has_aal2()` を独立に測れる。
  describe('表への直接書き込みも aal2 を要求する（RPC を通らない経路）', () => {
    it('発注の表へは aal2 でも直接 INSERT できない（作成の道は RPC だけ）', async () => {
      const client = createAnonClient()
      await signInAtAal1(client, email, TEST_USER_PASSWORD)
      await stepUpToAal2(client, factorId, secret)

      const { error } = await client.from('case_orders').insert({
        facility_id: facilityId,
        case_datetime: new Date().toISOString(),
        procedure_name: 'aal2で直接INSERT',
        patient_id: 'P-AAL2',
        patient_initials: 'ZZ',
        gender: 'other',
        doctor_name: 'テスト医師',
      })
      expect(isPermissionDenied(error), `INSERT の権限が戻っている（20260909040000 で剥がしたはず）: ${describeDenial(error)}`).toBe(true)
    })

    it('MFA登録済み・aal1のセッションでは consumables へ直接 INSERT できない', async () => {
      const client = createAnonClient()
      await signInAtAal1(client, email, TEST_USER_PASSWORD)

      const { error } = await client.from('consumables').insert({
        facility_id: facilityId,
        name: 'aal1で直接INSERT',
        purpose: 'テスト用途',
      })
      expect(error, 'aal1 で書けてしまった').not.toBeNull()
      // WHY(コードではなく文言で層を見分ける、2026-09-09 実測): PostgREST は
      //      **権限が無い場合も RLS の WITH CHECK に落ちた場合も 42501** を返す。
      //      層を見分けられるのは文言だけ（`permission denied for table` か
      //      `violates row-level security policy` か）。コードだけで判定すると、
      //      権限を剥がしただけの変更を「RLS が守っている」と読み違える（C-023 の形）
      expect(error?.message, '権限ではなく RLS（aal2）で止まっていること').toContain(
        'violates row-level security policy'
      )
    })

    it('aal2まで昇格すれば consumables へ直接 INSERT できる（拒否が aal2 由来であることの対照）', async () => {
      const client = createAnonClient()
      await signInAtAal1(client, email, TEST_USER_PASSWORD)
      await stepUpToAal2(client, factorId, secret)

      const { data, error } = await client
        .from('consumables')
        .insert({
          facility_id: facilityId,
          name: 'aal2で直接INSERT',
          purpose: 'テスト用途',
        })
        .select('id')
        .single()
      expect(error).toBeNull()
      if (data) await serviceClient.from('consumables').delete().eq('id', data.id)
    }, 30_000)
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
