// supabase/__tests__/integration/require-aal2-for-order-rpcs.integration.test.ts
// WHY: issue #612。発注RPCにaal2要求を追加した(20260806000001_require_aal2_for_order_rpcs.sql)。
//      「MFA未登録ユーザーは影響を受けない」だけでなく、本来の目的である「MFA登録済み
//      だがaal1のセッションは拒否され、aal2まで昇格したセッションは成功する」を、
//      実際のTOTP enroll→challenge→verifyフローで検証する。
//      TOTPコードはRFC 6238に基づきNode組み込みcryptoのみで生成し、新規npm依存
//      (otpauth等)を追加しない。

import { randomUUID, createHmac } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestSupabaseEnv } from '../../../e2e/env-guard'

const TEST_USER_PASSWORD = 'require-aal2-order-rpcs-test-0000'

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = input.toUpperCase().replace(/=+$/, '')
  let bits = ''
  for (const char of clean) {
    const val = alphabet.indexOf(char)
    if (val === -1) throw new Error(`invalid base32 character: ${char}`)
    bits += val.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  }
  return Buffer.from(bytes)
}

// RFC 6238 (TOTP) / RFC 4226 (HOTP) 準拠。30秒ステップ・6桁・SHA1。
function generateTotp(secretBase32: string): string {
  const key = base32Decode(secretBase32)
  const counter = Math.floor(Date.now() / 1000 / 30)
  const counterBuffer = Buffer.alloc(8)
  counterBuffer.writeBigUInt64BE(BigInt(counter))
  const hmac = createHmac('sha1', key).update(counterBuffer).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return (binCode % 1_000_000).toString().padStart(6, '0')
}

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

describe('発注RPCはMFA登録済みユーザーのaal2昇格を要求する(issue #612)', () => {
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
    const { error: signInError } = await client.auth.signInWithPassword({ email, password: TEST_USER_PASSWORD })
    expect(signInError).toBeNull()

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
    const { error: signInError } = await client.auth.signInWithPassword({ email, password: TEST_USER_PASSWORD })
    expect(signInError).toBeNull()

    const { data: enrollData, error: enrollError } = await client.auth.mfa.enroll({ factorType: 'totp' })
    expect(enrollError).toBeNull()
    expect(enrollData).not.toBeNull()
    factorId = enrollData!.id
    secret = enrollData!.totp.secret

    const { data: challengeData, error: challengeError } = await client.auth.mfa.challenge({ factorId })
    expect(challengeError).toBeNull()

    const { error: verifyError } = await client.auth.mfa.verify({
      factorId,
      challengeId: challengeData!.id,
      code: generateTotp(secret),
    })
    expect(verifyError).toBeNull()
  }, 30_000)

  it('MFA登録済みだがaal1のセッションでは発注RPCがforbidden(aal2 required)で拒否される', async () => {
    // パスワードのみの再サインインは、factorが検証済みでも新規セッションはaal1から始まる
    // (src/middleware.tsのnextLevel判定と同じ挙動)
    const client = createAnonClient()
    const { error: signInError } = await client.auth.signInWithPassword({ email, password: TEST_USER_PASSWORD })
    expect(signInError).toBeNull()

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
    const { error: signInError } = await client.auth.signInWithPassword({ email, password: TEST_USER_PASSWORD })
    expect(signInError).toBeNull()

    const { data: challengeData, error: challengeError } = await client.auth.mfa.challenge({ factorId })
    expect(challengeError).toBeNull()

    const { error: verifyError } = await client.auth.mfa.verify({
      factorId,
      challengeId: challengeData!.id,
      code: generateTotp(secret),
    })
    expect(verifyError).toBeNull()

    const { error } = await client.rpc('create_loan_order_atomic', {
      p_facility_id: facilityId,
      p_procedure_name: 'aal2テスト術式(aal2で成功)',
      p_maker: 'テストメーカー',
      p_items: [],
    })
    expect(error).toBeNull()
  })
})
