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

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestSupabaseEnv } from '../../../e2e/env-guard'
import { enrollAndVerifyTotp, signInAtAal1 as signInClientAtAal1, stepUpToAal2 } from './helpers/mfa-totp'

const TEST_USER_PASSWORD = 'require-aal2-facility-writer-rls-test-0000'

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

// 約束カタログ（docs/agents/promise-catalog.md）: P-031 RPC 非経由の直接 INSERT にも aal2
describe('facility_writer_or_adminポリシーはRPCを経由しない直接書き込みにもaal2を要求する(issue #623) [P-031]', () => {
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
    await signInClientAtAal1(client, email, TEST_USER_PASSWORD)
    const enrolled = await enrollAndVerifyTotp(client)
    factorId = enrolled.factorId
    secret = enrolled.secret

    // case_order_items/consumables/loan_return_itemsのjanはproducts(jan)へのFKのため、
    // 使用するjan分だけ事前にproductsへ登録しておく(issue #684)
    const { error: productsError } = await serviceClient.from('products').insert(
      [`999${runId}-1`, `999${runId}-2`, `111${runId}`, `222${runId}`, `333${runId}`].map((jan) => ({
        jan,
        ref: `REF-${jan}`,
        name: `RLSテスト製品-${jan}`,
      }))
    )
    if (productsError) throw new Error(`products作成失敗: ${productsError.message}`)
  }, 60_000)

  afterAll(async () => {
    await serviceClient.auth.admin.deleteUser(userId)
    await serviceClient.from('facilities').delete().eq('id', facilityId)
    await serviceClient
      .from('products')
      .delete()
      .in('jan', [`999${runId}-1`, `999${runId}-2`, `111${runId}`, `222${runId}`, `333${runId}`])
  })

  async function signInAtAal1(): Promise<SupabaseClient> {
    const client = createAnonClient()
    await signInClientAtAal1(client, email, TEST_USER_PASSWORD)
    return client
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
    await stepUpToAal2(client, factorId, secret)

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

  it('MFA登録済みだがaal1のセッションでは、consumable_ordersへの直接INSERT(RPC非経由)がRLSで拒否される(issue #684)', async () => {
    const client = await signInAtAal1()

    const { error } = await client.from('consumable_orders').insert({ facility_id: facilityId })

    expect(error).not.toBeNull()
  })

  it('aal2まで昇格したセッションでは、consumable_ordersへの直接INSERT(RPC非経由)が成功する(issue #684)', async () => {
    const client = await signInAtAal1()
    await stepUpToAal2(client, factorId, secret)

    const { error } = await client.from('consumable_orders').insert({ facility_id: facilityId })

    expect(error).toBeNull()
  })

  it('MFA登録済みだがaal1のセッションでは、loan_ordersへの直接INSERT(RPC非経由)がRLSで拒否される(issue #684)', async () => {
    const client = await signInAtAal1()

    const { error } = await client.from('loan_orders').insert({
      facility_id: facilityId,
      procedure_name: 'RLS直接書き込みテスト(aal1)',
      maker: 'テストメーカー',
    })

    expect(error).not.toBeNull()
  })

  it('aal2まで昇格したセッションでは、loan_ordersへの直接INSERT(RPC非経由)が成功する(issue #684)', async () => {
    const client = await signInAtAal1()
    await stepUpToAal2(client, factorId, secret)

    const { error } = await client.from('loan_orders').insert({
      facility_id: facilityId,
      procedure_name: 'RLS直接書き込みテスト(aal2)',
      maker: 'テストメーカー',
    })

    expect(error).toBeNull()
  })

  it('MFA登録済みだがaal1のセッションでは、loan_returnsへの直接INSERT(RPC非経由)がRLSで拒否される(issue #684)', async () => {
    const client = await signInAtAal1()

    const { error } = await client.from('loan_returns').insert({
      facility_id: facilityId,
      return_datetime: new Date().toISOString(),
    })

    expect(error).not.toBeNull()
  })

  it('aal2まで昇格したセッションでは、loan_returnsへの直接INSERT(RPC非経由)が成功する(issue #684)', async () => {
    const client = await signInAtAal1()
    await stepUpToAal2(client, factorId, secret)

    const { error } = await client.from('loan_returns').insert({
      facility_id: facilityId,
      return_datetime: new Date().toISOString(),
    })

    expect(error).toBeNull()
  })

  it('MFA登録済みだがaal1のセッションでは、consumablesへの直接INSERT(RPC非経由)がRLSで拒否される(issue #684)', async () => {
    const client = await signInAtAal1()

    const { error } = await client.from('consumables').insert({
      facility_id: facilityId,
      name: 'RLSテスト消耗品',
      jan: `999${runId}-1`,
      purpose: 'テスト用途',
    })

    expect(error).not.toBeNull()
  })

  it('aal2まで昇格したセッションでは、consumablesへの直接INSERT(RPC非経由)が成功する(issue #684)', async () => {
    const client = await signInAtAal1()
    await stepUpToAal2(client, factorId, secret)

    const { error } = await client.from('consumables').insert({
      facility_id: facilityId,
      name: 'RLSテスト消耗品',
      jan: `999${runId}-2`,
      purpose: 'テスト用途',
    })

    expect(error).toBeNull()
  })

  describe('明細4テーブルへの直接INSERT(親経由のEXISTS+has_aal2()判定、issue #684)', () => {
    it('case_order_itemsはaal1で拒否・aal2で成功する', async () => {
      const { data: parent } = await serviceClient
        .from('case_orders')
        .insert({
          facility_id: facilityId,
          case_datetime: new Date().toISOString(),
          procedure_name: '明細RLSテスト術式',
          patient_id: 'PT-ITEM-1',
          patient_initials: 'I.T.',
          gender: 'other',
          doctor_name: 'RLSテスト医師',
        })
        .select('id')
        .single()

      const aal1Client = await signInAtAal1()
      const { error: aal1Error } = await aal1Client
        .from('case_order_items')
        .insert({ case_order_id: parent!.id, jan: `111${runId}`, quantity: 1 })
      expect(aal1Error).not.toBeNull()

      const aal2Client = await signInAtAal1()
      await stepUpToAal2(aal2Client, factorId, secret)
      const { error: aal2Error } = await aal2Client
        .from('case_order_items')
        .insert({ case_order_id: parent!.id, jan: `111${runId}`, quantity: 1 })
      expect(aal2Error).toBeNull()
    })

    it('consumable_order_itemsはaal1で拒否・aal2で成功する', async () => {
      const { data: consumable } = await serviceClient
        .from('consumables')
        .insert({
          facility_id: facilityId,
          name: '明細RLSテスト消耗品',
          jan: `222${runId}`,
          purpose: 'テスト用途',
        })
        .select('id')
        .single()
      const { data: parent } = await serviceClient
        .from('consumable_orders')
        .insert({ facility_id: facilityId })
        .select('id')
        .single()

      const aal1Client = await signInAtAal1()
      const { error: aal1Error } = await aal1Client
        .from('consumable_order_items')
        .insert({ consumable_order_id: parent!.id, consumable_id: consumable!.id, quantity: 1 })
      expect(aal1Error).not.toBeNull()

      const aal2Client = await signInAtAal1()
      await stepUpToAal2(aal2Client, factorId, secret)
      const { error: aal2Error } = await aal2Client
        .from('consumable_order_items')
        .insert({ consumable_order_id: parent!.id, consumable_id: consumable!.id, quantity: 1 })
      expect(aal2Error).toBeNull()
    })

    it('loan_order_itemsはaal1で拒否・aal2で成功する', async () => {
      const { data: parent } = await serviceClient
        .from('loan_orders')
        .insert({
          facility_id: facilityId,
          procedure_name: '明細RLSテスト術式',
          maker: 'テストメーカー',
        })
        .select('id')
        .single()

      const aal1Client = await signInAtAal1()
      const { error: aal1Error } = await aal1Client
        .from('loan_order_items')
        .insert({ loan_order_id: parent!.id, name: '明細RLSテスト器械', quantity: 1 })
      expect(aal1Error).not.toBeNull()

      const aal2Client = await signInAtAal1()
      await stepUpToAal2(aal2Client, factorId, secret)
      const { error: aal2Error } = await aal2Client
        .from('loan_order_items')
        .insert({ loan_order_id: parent!.id, name: '明細RLSテスト器械', quantity: 1 })
      expect(aal2Error).toBeNull()
    })

    it('loan_return_itemsはaal1で拒否・aal2で成功する', async () => {
      const { data: parent } = await serviceClient
        .from('loan_returns')
        .insert({ facility_id: facilityId, return_datetime: new Date().toISOString() })
        .select('id')
        .single()

      const aal1Client = await signInAtAal1()
      const { error: aal1Error } = await aal1Client
        .from('loan_return_items')
        .insert({ loan_return_id: parent!.id, jan: `333${runId}`, quantity: 1 })
      expect(aal1Error).not.toBeNull()

      const aal2Client = await signInAtAal1()
      await stepUpToAal2(aal2Client, factorId, secret)
      const { error: aal2Error } = await aal2Client
        .from('loan_return_items')
        .insert({ loan_return_id: parent!.id, jan: `333${runId}`, quantity: 1 })
      expect(aal2Error).toBeNull()
    })
  })
})
