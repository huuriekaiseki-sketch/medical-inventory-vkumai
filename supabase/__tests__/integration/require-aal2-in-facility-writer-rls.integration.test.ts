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
import { describeDenial, isPermissionDenied } from './helpers/pg-error'

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
    // WHY(`888` と カテゴリも消す、2026-09-09): 価格の直接 INSERT を測る it が
    //      製品・カテゴリ・代理店商品をその場で作っていたのに、後片付けの一覧に入っていなかった。
    //      緑の実行のたびに 3 行ずつ残っていた（distributor_products は products の CASCADE で消える）。
    const { error: productError } = await serviceClient
      .from('products')
      .delete()
      .in('jan', [`999${runId}-1`, `999${runId}-2`, `111${runId}`, `222${runId}`, `333${runId}`, `888${runId}`])
    if (productError) throw new Error(`[aal2-rls] products の後片付けに失敗: ${productError.message}`)
    const { error: categoryError } = await serviceClient
      .from('categories')
      .delete()
      .like('name', `%${runId}%`)
    if (categoryError) throw new Error(`[aal2-rls] categories の後片付けに失敗: ${categoryError.message}`)
  })

  async function signInAtAal1(): Promise<SupabaseClient> {
    const client = createAnonClient()
    await signInClientAtAal1(client, email, TEST_USER_PASSWORD)
    return client
  }

  // WHY(2026-09-09 に約束が変わった): 発注 3 種・返却とその明細への**直接 INSERT の道は無くなった**
  //      （20260909040000 で権限ごと剥がした）。作成は SECURITY DEFINER の RPC だけが行う。
  //      aal2 の要求はこれらの表では **UPDATE（取り消し）側**で測る（下の describe）。
  //      RPC 側の has_aal2() は require-aal2-for-order-rpcs.integration.test.ts が測る。
  it('aal2まで昇格しても、case_ordersへの直接INSERTはできない(作成の道はRPCだけ)', async () => {
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

    expect(isPermissionDenied(error), `INSERT の権限が戻っている（20260909040000 で剥がしたはず）: ${describeDenial(error)}`).toBe(true)
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

  it('aal2まで昇格しても、consumable_ordersへの直接INSERTはできない(作成の道はRPCだけ)', async () => {
    const client = await signInAtAal1()
    await stepUpToAal2(client, factorId, secret)

    const { error } = await client.from('consumable_orders').insert({ facility_id: facilityId })

    expect(isPermissionDenied(error), `INSERT の権限が戻っている: ${describeDenial(error)}`).toBe(true)
  })

  it('aal2まで昇格しても、loan_ordersへの直接INSERTはできない(作成の道はRPCだけ)', async () => {
    const client = await signInAtAal1()
    await stepUpToAal2(client, factorId, secret)

    const { error } = await client.from('loan_orders').insert({
      facility_id: facilityId,
      procedure_name: 'RLS直接書き込みテスト(aal2)',
      maker: 'テストメーカー',
    })

    expect(isPermissionDenied(error), `INSERT の権限が戻っている: ${describeDenial(error)}`).toBe(true)
  })

  it('aal2まで昇格しても、loan_returnsへの直接INSERTはできない(作成の道はRPCだけ)', async () => {
    const client = await signInAtAal1()
    await stepUpToAal2(client, factorId, secret)

    const { error } = await client.from('loan_returns').insert({
      facility_id: facilityId,
      return_datetime: new Date().toISOString(),
    })

    expect(isPermissionDenied(error), `INSERT の権限が戻っている: ${describeDenial(error)}`).toBe(true)
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

  describe('明細 4 表への直接 INSERT（2026-09-09 に道ごと無くした）', () => {
    // WHY(約束が変わった): 明細も RPC の中でだけ入る。クライアントの INSERT 権限は
    //      20260909040000 で剥がしたので、**aal2 まで昇格しても入れられない**。
    //      これで case_order_items / consumable_order_items / loan_order_items は
    //      クライアントから書く道が 1 つも無くなった（読みだけ）。
    const itemTables = ['case_order_items', 'consumable_order_items', 'loan_order_items', 'loan_return_items'] as const

    it.each(itemTables)('%s は aal2 でも直接 INSERT できない', async (table) => {
      const client = await signInAtAal1()
      await stepUpToAal2(client, factorId, secret)

      // 親の id は要らない（権限が無いので、行の中身を組み立てる前に弾かれる）
      const { error } = await client.from(table).insert({ quantity: 1 })
      expect(isPermissionDenied(error), `${table} の INSERT 権限が戻っている: ${describeDenial(error)}`).toBe(true)
    })
  })

  // WHY(aal2 の測り場所を移した): 直接 INSERT の道が無くなったので、
  //      取り消しのポリシーの `has_aal2()` を**取り消し（UPDATE）側**で測る。
  //      ここが無いと、発注・返却の表で aal2 の判定を一度も測らないまま緑になる（C-021）。
  //
  // WHY(4 表すべてを回す、2026-09-10): 2026-09-09 まで `loan_orders` 1 表だけを測っていた。
  //      **ポリシーは表ごとに別物**なので、1 表で測っても他の 3 表は何も守られていない。
  //      RLS の変異計測（RM-002: `case_orders` の書き込みから aal2 を外す）が
  //      **生き残り**として実測で見つけた——直接 INSERT のテストは権限の層で先に止まるため、
  //      ポリシーを壊しても気づけなくなっていた（C-023: 探りが別の防御に依存）。
  //      表を足したら行を足す（C-011: 1 表だけの検査を「守っている」と読まない）。
  const cancellable: Array<{ table: string; row: () => Record<string, unknown> }> = [
    {
      table: 'case_orders',
      row: () => ({
        facility_id: facilityId,
        case_datetime: new Date().toISOString(),
        procedure_name: '取り消しaal2テスト',
        patient_id: 'AAL2-CANCEL',
        patient_initials: 'テ',
        gender: 'other',
        doctor_name: '取り消しaal2テスト医師',
      }),
    },
    { table: 'consumable_orders', row: () => ({ facility_id: facilityId }) },
    {
      table: 'loan_orders',
      row: () => ({ facility_id: facilityId, procedure_name: '取り消しaal2テスト', maker: 'テストメーカー' }),
    },
    {
      table: 'loan_returns',
      row: () => ({ facility_id: facilityId, return_datetime: new Date().toISOString() }),
    },
  ]

  describe('取り消し（UPDATE）には引き続き aal2 が要る', () => {
    it.each(cancellable)(
      '$table: aal1 では取り消せず、aal2 まで昇格すると取り消せる',
      async ({ table, row }) => {
        const { data: created, error: seedError } = await serviceClient
          .from(table)
          .insert(row())
          .select('id')
          .single()
        if (seedError || !created) throw new Error(`[aal2-cancel] ${table} のシード失敗: ${seedError?.message}`)

        const aal1Client = await signInAtAal1()
        const { data: aal1Updated, error: aal1Error } = await aal1Client
          .from(table)
          .update({ status: 'cancelled' })
          .eq('id', created.id)
          .select('id')
        // 権限はあるのでエラーにはならない。**RLS が 0 行にする**（aal2 を満たさないため）
        expect(aal1Error).toBeNull()
        expect(aal1Updated ?? [], `${table} を aal1 のセッションで取り消せてしまった`).toEqual([])

        const aal2Client = await signInAtAal1()
        await stepUpToAal2(aal2Client, factorId, secret)
        const { data: aal2Updated, error: aal2Error } = await aal2Client
          .from(table)
          .update({ status: 'cancelled' })
          .eq('id', created.id)
          .select('id')
        // 対照: aal2 なら通る。これが無いと「常に 0 行」でも緑になる（C-021）
        expect(aal2Error).toBeNull()
        expect(aal2Updated ?? [], `${table} は aal2 でも取り消せない（UPDATE の道まで塞がっている）`).toHaveLength(1)
        // 後片付けはしない（施設スコープの行なので、afterAll の施設削除で連鎖して消える）。
        // ここで消すと**戻り値を見ない削除**が 1 つ増えるだけで、消し残しの計測が拾う話でもない（E-065）
      },
      60_000
    )
  })
})
