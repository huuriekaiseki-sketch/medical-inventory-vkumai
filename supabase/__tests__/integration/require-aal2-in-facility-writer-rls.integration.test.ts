// supabase/__tests__/integration/require-aal2-in-facility-writer-rls.integration.test.ts
// WHY: issue #623。20260806000001でcreate_case_order_atomic等4RPCの内部にhas_aal2()
//      チェックを追加したが、テーブル自体のRLSポリシー(facility_writer_or_admin)は
//      aal2判定を含んでいなかったため、RPCを経由しない直接テーブル書き込み
//      (PostgRESTの.from().insert()等)ではaal1のままでも書き込めてしまっていた。
//      20260806000002でRLSポリシー自体にhas_aal2()を追加した修正が、実際にRPCを
//      経由しない直接書き込みを拒否することを実測する(#612実装時と同じ理由で、
//      コードレビューだけでは実行時の抜け穴を検知できないため実DBで検証する)。
//
//      あわせて、facilities(施設名更新)は意図的にaal2要求の対象外としたため、
//      MFA登録済み・aal1のままでも更新できることも回帰確認する。

import { randomUUID, createHmac } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestSupabaseEnv } from '../../../e2e/env-guard'

const TEST_USER_PASSWORD = 'require-aal2-facility-writer-rls-test-0000'

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
      '[require-aal2-in-facility-writer-rls] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。'
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

describe('facility_writer_or_adminポリシーはRPCを経由しない直接書き込みにもaal2を要求する(issue #623)', () => {
  const runId = randomUUID()
  const serviceClient = createServiceRoleClient()
  const email = `require-aal2-rls-${runId}@example.test`

  let facilityId: string
  let userId: string
  let factorId: string
  let secret: string

  beforeAll(async () => {
    const { data: facility, error: facilityError } = await serviceClient
      .from('facilities')
      .insert({ name: `テスト施設-AAL2RLS-${runId}` })
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

    // 以降のテストで使うTOTP factorをここで一度だけ登録する
    const client = createAnonClient()
    const { error: signInError } = await client.auth.signInWithPassword({ email, password: TEST_USER_PASSWORD })
    if (signInError) throw new Error(`サインイン失敗: ${signInError.message}`)

    const { data: enrollData, error: enrollError } = await client.auth.mfa.enroll({ factorType: 'totp' })
    if (enrollError || !enrollData) throw new Error(`MFA enroll失敗: ${enrollError?.message}`)
    factorId = enrollData.id
    secret = enrollData.totp.secret

    const { data: challengeData, error: challengeError } = await client.auth.mfa.challenge({ factorId })
    if (challengeError || !challengeData) throw new Error(`MFA challenge失敗: ${challengeError?.message}`)

    const { error: verifyError } = await client.auth.mfa.verify({
      factorId,
      challengeId: challengeData.id,
      code: generateTotp(secret),
    })
    if (verifyError) throw new Error(`MFA verify失敗: ${verifyError.message}`)
  }, 60_000)

  afterAll(async () => {
    await serviceClient.auth.admin.deleteUser(userId)
    await serviceClient.from('facilities').delete().eq('id', facilityId)
  })

  async function signInAtAal1(): Promise<SupabaseClient> {
    // パスワードのみの再サインインは、factorが検証済みでも新規セッションはaal1から始まる
    const client = createAnonClient()
    const { error } = await client.auth.signInWithPassword({ email, password: TEST_USER_PASSWORD })
    if (error) throw new Error(`サインイン失敗: ${error.message}`)
    return client
  }

  async function stepUpToAal2(client: SupabaseClient): Promise<void> {
    const { data: challengeData, error: challengeError } = await client.auth.mfa.challenge({ factorId })
    if (challengeError || !challengeData) throw new Error(`MFA challenge失敗: ${challengeError?.message}`)
    const { error: verifyError } = await client.auth.mfa.verify({
      factorId,
      challengeId: challengeData.id,
      code: generateTotp(secret),
    })
    if (verifyError) throw new Error(`MFA verify失敗: ${verifyError.message}`)
  }

  it('MFA登録済みだがaal1のセッションでは、case_ordersへの直接INSERT(RPC非経由)がRLSで拒否される', async () => {
    const client = await signInAtAal1()

    const { error } = await client.from('case_orders').insert({
      facility_id: facilityId,
      case_datetime: new Date().toISOString(),
      procedure_name: 'RLS直接書き込みテスト(aal1)',
      patient_id: 'PT-RLS-1',
      patient_initials: 'R.L.',
      gender: 'other',
      doctor_name: 'RLSテスト医師',
    })

    expect(error).not.toBeNull()
  })

  it('aal2まで昇格したセッションでは、case_ordersへの直接INSERT(RPC非経由)が成功する', async () => {
    const client = await signInAtAal1()
    await stepUpToAal2(client)

    const { error } = await client.from('case_orders').insert({
      facility_id: facilityId,
      case_datetime: new Date().toISOString(),
      procedure_name: 'RLS直接書き込みテスト(aal2)',
      patient_id: 'PT-RLS-2',
      patient_initials: 'R.L.',
      gender: 'other',
      doctor_name: 'RLSテスト医師',
    })

    expect(error).toBeNull()
  })

  it('MFA登録済みだがaal1のセッションでは、hospital_pricesへの直接INSERTもRLSで拒否される(issue #619の判断: 価格改定も対象)', async () => {
    const { data: product } = await serviceClient
      .from('products')
      .insert({ jan: `888${runId}`, ref: `REF-RLS-${runId}`, name: 'RLSテスト製品' })
      .select('id')
      .single()
    const { data: category } = await serviceClient
      .from('categories')
      .insert({ name: `RLSテストカテゴリ-${runId}` })
      .select('id')
      .single()
    const { data: dp } = await serviceClient
      .from('distributor_products')
      .insert({
        product_id: product!.id,
        category_id: category!.id,
        maker: 'テストメーカー',
        supplier: 'テスト仕入先',
        name: 'RLSテスト商品',
        reimbursement_price: 1000,
        quantity: 1,
      })
      .select('id')
      .single()

    const client = await signInAtAal1()
    const { error } = await client.from('hospital_prices').insert({
      facility_id: facilityId,
      distributor_product_id: dp!.id,
      purchase_price: 500,
      delivery_price: 700,
    })

    expect(error).not.toBeNull()
  })

  it('facilitiesの更新(施設名変更)は意図的に対象外のため、aal1のままでも成功する(issue #623の除外判断の回帰確認)', async () => {
    const client = await signInAtAal1()

    const { error } = await client
      .from('facilities')
      .update({ name: `RLSテスト施設-更新済み-${runId}` })
      .eq('id', facilityId)

    expect(error).toBeNull()
  })
})
