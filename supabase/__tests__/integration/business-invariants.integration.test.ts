// supabase/__tests__/integration/business-invariants.integration.test.ts
// WHY: issue #757 の 3。不変条件カタログ（docs/agents/invariant-catalog.md）の各行は
//      「破る操作が拒否されること」でしか確かめられない（#675 の教訓: 静的 SQL 検証は約束を破れない）。
//      RPC 経由・直接 INSERT・service_role のそれぞれから破ろうとして 23514 で止まることを実 DB で見る。
//      派生値（粗利・掛け率）は「常に等しい」を INSERT 直後と償還価格の変更後で確かめる。

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupHospitalPricesRlsIdorFixtures,
  createFacility,
  createSeededUser,
  createServiceRoleClient,
  seedHospitalPricesRlsIdorFixtures,
  type SeedHospitalPricesRlsIdorFixtures,
} from './helpers/seed-rls-idor'

const CHECK_VIOLATION = '23514'

describe('業務不変条件（DB 制約・トリガー） [I-010 I-011 I-012 I-013 I-014 I-020 I-021 I-040 I-062]', () => {
  const serviceClient = createServiceRoleClient()
  let fx: SeedHospitalPricesRlsIdorFixtures
  let jan: string

  beforeAll(async () => {
    fx = await seedHospitalPricesRlsIdorFixtures()
    const { data } = await serviceClient.from('products').select('jan').eq('id', fx.masters.productId).single()
    jan = data!.jan as string
  }, 60_000)

  afterAll(async () => {
    if (fx) await cleanupHospitalPricesRlsIdorFixtures(fx)
  })

  describe('I-010 発注明細の数量は 1 以上（RPC 経由でも止まる）', () => {
    it('短貸発注: quantity 0 の明細は 23514 で拒否され、発注ヘッダも残らない', async () => {
      const { error } = await fx.userA.client.rpc('create_loan_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_procedure_name: '不変条件テスト',
        p_maker: 'テストメーカー',
        p_items: [{ jan: null, name: '数量ゼロ', quantity: 0 }],
      })
      expect(error?.code).toBe(CHECK_VIOLATION)
      const { data: rows } = await serviceClient.from('loan_orders').select('id').eq('facility_id', fx.facilityA.id).eq('procedure_name', '不変条件テスト')
      expect(rows).toEqual([])
    })

    it('症例発注: quantity -1 の明細は 23514', async () => {
      const { error } = await fx.userA.client.rpc('create_case_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_case_datetime: new Date().toISOString(),
        p_procedure_name: '不変条件テスト',
        p_patient_id: 'PT-INV-1',
        p_patient_initials: 'I.V.',
        p_gender: 'other',
        p_doctor_name: 'テスト医師',
        p_items: [{ jan, lot: null, ubd: null, quantity: -1 }],
      })
      expect(error?.code).toBe(CHECK_VIOLATION)
    })

    it('消耗品発注: quantity 0 の明細は 23514', async () => {
      const { data: consumable } = await serviceClient
        .from('consumables')
        .insert({ facility_id: fx.facilityA.id, name: '不変条件テスト消耗品', purpose: 'test' })
        .select('id')
        .single()
      const { error } = await fx.userA.client.rpc('create_consumable_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_items: [{ consumable_id: consumable!.id, quantity: 0 }],
      })
      expect(error?.code).toBe(CHECK_VIOLATION)
    })
  })

  describe('I-011 返却明細の数量は 1 以上', () => {
    it('返却 RPC: quantity 0 の明細は 23514', async () => {
      const { error } = await fx.userA.client.rpc('create_loan_return_atomic', {
        p_header: { facility_id: fx.facilityA.id, return_datetime: new Date().toISOString(), loan_order_id: null },
        p_items: [{ jan, lot: null, ubd: null, quantity: 0 }],
      })
      expect(error?.code).toBe(CHECK_VIOLATION)
    })
  })

  describe('I-012 明細の単価スナップショットは 0 以上（service_role の直接 INSERT でも止まる）', () => {
    it('loan_order_items.unit_price = -1 は 23514、NULL は許される', async () => {
      const { data: order, error: orderError } = await fx.userA.client.rpc('create_loan_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_procedure_name: '単価テスト',
        p_maker: 'テストメーカー',
        p_items: [],
      })
      expect(orderError).toBeNull()
      const orderId = (order as { id: string }).id

      const { error: negative } = await serviceClient
        .from('loan_order_items')
        .insert({ loan_order_id: orderId, name: '負の単価', quantity: 1, unit_price: -1 })
      expect(negative?.code).toBe(CHECK_VIOLATION)

      const { error: nullPrice } = await serviceClient
        .from('loan_order_items')
        .insert({ loan_order_id: orderId, name: '単価なし', quantity: 1, unit_price: null })
      expect(nullPrice).toBeNull()
    })

    // WHY(2026-09-08 の棚卸しで見つけた): カタログの I-012 は
    //      CHECK `*_order_items_unit_price_nonnegative` と**全明細表**を指しているのに、
    //      測っていたのは `loan_order_items` の 1 表だけだった。
    //      同じ不変条件を表ごとに宣言して 1 表しか測らないのは、
    //      products の文字数（E-024）とまったく同じ形。
    it('consumable_order_items.unit_price = -1 も 23514（同じ不変条件を表ごとに測る）', async () => {
      const { data: consumable } = await serviceClient
        .from('consumables')
        .insert({ facility_id: fx.facilityA.id, name: '単価テスト消耗品', purpose: 'test' })
        .select('id')
        .single()
      const { data: order, error: orderError } = await fx.userA.client.rpc('create_consumable_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_items: [{ consumable_id: consumable!.id, quantity: 1 }],
      })
      expect(orderError).toBeNull()
      const orderId = (order as { id: string }).id

      const { error: negative } = await serviceClient
        .from('consumable_order_items')
        .insert({ consumable_order_id: orderId, consumable_id: consumable!.id, quantity: 1, unit_price: -1 })
      expect(negative?.code).toBe(CHECK_VIOLATION)

      const { error: nullPrice } = await serviceClient
        .from('consumable_order_items')
        .insert({ consumable_order_id: orderId, consumable_id: consumable!.id, quantity: 1, unit_price: null })
      expect(nullPrice).toBeNull()
    })
  })

  // WHY(2026-09-08 の棚卸しで見つけた): 状態の**語彙**（どの値を許すか）は、
  //      前にしか進まないこと（I-020）とは別の約束。消耗品発注だけ語彙を測っていなかった。
  //      語彙が黙って広がると、画面・集計・状態遷移のトリガーがそれぞれ別の前提で動き出す。
  describe('I-021 状態の語彙は決めた値だけ（消耗品発注）', () => {
    it('決めていない状態へは更新できない', async () => {
      const { data: consumable } = await serviceClient
        .from('consumables')
        .insert({ facility_id: fx.facilityA.id, name: '状態語彙テスト消耗品', purpose: 'test' })
        .select('id')
        .single()
      const { data: order, error: orderError } = await fx.userA.client.rpc('create_consumable_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_items: [{ consumable_id: consumable!.id, quantity: 1 }],
      })
      expect(orderError).toBeNull()
      const orderId = (order as { id: string }).id

      const { error } = await serviceClient
        .from('consumable_orders')
        .update({ status: 'shipped' })
        .eq('id', orderId)
      expect(error?.code).toBe(CHECK_VIOLATION)

      // 決めてある値へは進める（対照。語彙の検査が「何も通さない」形で緑になっていないこと）
      const { error: allowed } = await serviceClient
        .from('consumable_orders')
        .update({ status: 'submitted' })
        .eq('id', orderId)
      expect(allowed).toBeNull()
    })
  })

  // WHY(2026-09-08 の棚卸しで見つけた): I-062 は
  //      `case_order_items` / `loan_order_items` / `loan_return_items` の 3 つの CHECK を
  //      **1 行にまとめて宣言している**が、実際に測っていたのは `case_order_items` だけだった。
  //      ワイルドカード（`*_items_text_length`）で書けてしまうので、
  //      **カタログの行を読んだだけでは何表ぶん測ったか分からない**。残り 2 表をここで測る。
  describe('I-062 明細の自由入力の上限は 3 つの明細表すべてで効く', () => {
    // WHY(表ごとに列が違う): `loan_order_items` は lot / ubd を持たず、
    //      CHECK が見るのは jan（64）と name（200）だけ。**同じ I-062 でも列が同じではない**
    it('loan_order_items の品名は 200 文字を超えると 23514（境界の反対側も見る）', async () => {
      const { data: order, error: orderError } = await fx.userA.client.rpc('create_loan_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_procedure_name: '明細長さテスト',
        p_maker: 'テストメーカー',
        p_items: [],
      })
      expect(orderError).toBeNull()
      const orderId = (order as { id: string }).id

      const { error: tooLong } = await serviceClient
        .from('loan_order_items')
        .insert({ loan_order_id: orderId, name: 'あ'.repeat(201), quantity: 1 })
      expect(tooLong?.code).toBe(CHECK_VIOLATION)

      const { error: edge } = await serviceClient
        .from('loan_order_items')
        .insert({ loan_order_id: orderId, name: 'あ'.repeat(200), quantity: 1 })
      expect(edge, '境界ちょうどが拒否された').toBeNull()
    })

    it('loan_return_items のロットは 100 文字を超えると 23514（境界の反対側も見る）', async () => {
      const { data: ret, error: retError } = await fx.userA.client.rpc('create_loan_return_atomic', {
        p_header: { facility_id: fx.facilityA.id, return_datetime: new Date().toISOString(), loan_order_id: null },
        p_items: [{ jan, lot: null, ubd: null, quantity: 1 }],
      })
      expect(retError).toBeNull()
      const returnId = (ret as { id: string }).id

      const { error: tooLong } = await serviceClient
        .from('loan_return_items')
        .insert({ loan_return_id: returnId, jan, lot: 'あ'.repeat(101), quantity: 1 })
      expect(tooLong?.code).toBe(CHECK_VIOLATION)

      const { error: edge } = await serviceClient
        .from('loan_return_items')
        .insert({ loan_return_id: returnId, jan, lot: 'あ'.repeat(100), quantity: 1 })
      expect(edge, '境界ちょうどが拒否された').toBeNull()
    })
  })

  describe('I-013 施設別価格の仕切値・納品価格は 0 以上', () => {
    it('purchase_price = -1 は 23514、UPDATE で負にするのも 23514', async () => {
      const { error: insertError } = await fx.userA.client.from('hospital_prices').insert({
        distributor_product_id: fx.distributorProductForInsert.id,
        facility_id: fx.facilityA.id,
        purchase_price: -1,
        delivery_price: 100,
      })
      expect(insertError?.code).toBe(CHECK_VIOLATION)

      const { error: updateError } = await fx.userA.client
        .from('hospital_prices')
        .update({ delivery_price: -5 })
        .eq('id', fx.hospitalPriceA.id)
      expect(updateError?.code).toBe(CHECK_VIOLATION)
    })
  })

  describe('I-014 代理店商品の入数は 1 以上、償還価格は 0 以上', () => {
    it('quantity 0 と reimbursement_price -1 は service_role でも 23514', async () => {
      const base = { product_id: fx.masters.productId, category_id: fx.masters.categoryId, maker: 'm', supplier: 's', name: '不変条件テスト' }
      const { error: q } = await serviceClient.from('distributor_products').insert({ ...base, quantity: 0 })
      expect(q?.code).toBe(CHECK_VIOLATION)
      const { error: r } = await serviceClient.from('distributor_products').insert({ ...base, reimbursement_price: -1 })
      expect(r?.code).toBe(CHECK_VIOLATION)
    })
  })

  describe('I-020 状態は前にしか進まない', () => {
    it('loan_orders: draft → submitted は通り、submitted → draft は service_role でも 23514', async () => {
      const { data: order } = await fx.userA.client.rpc('create_loan_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_procedure_name: '状態遷移テスト',
        p_maker: 'テストメーカー',
        p_items: [],
      })
      const orderId = (order as { id: string }).id

      const { error: forward } = await serviceClient.from('loan_orders').update({ status: 'submitted' }).eq('id', orderId)
      expect(forward).toBeNull()

      const { error: backward } = await serviceClient.from('loan_orders').update({ status: 'draft' }).eq('id', orderId)
      expect(backward?.code).toBe(CHECK_VIOLATION)

      const { data: after } = await serviceClient.from('loan_orders').select('status').eq('id', orderId).single()
      expect(after?.status).toBe('submitted')
    })

    it('loan_returns: returned → draft は 23514', async () => {
      const { data: ret } = await fx.userA.client.rpc('create_loan_return_atomic', {
        p_header: { facility_id: fx.facilityA.id, return_datetime: new Date().toISOString(), loan_order_id: null },
        p_items: [],
      })
      const returnId = (ret as { id: string }).id
      const { error: forward } = await serviceClient.from('loan_returns').update({ status: 'returned' }).eq('id', returnId)
      expect(forward).toBeNull()
      const { error: backward } = await serviceClient.from('loan_returns').update({ status: 'draft' }).eq('id', returnId)
      expect(backward?.code).toBe(CHECK_VIOLATION)
    })
  })

  describe('I-040 粗利と掛け率は常に価格から導かれる', () => {
    it('gross_profit = delivery − purchase、掛け率は償還価格の変更に追従する', async () => {
      await serviceClient.from('distributor_products').update({ reimbursement_price: 200 }).eq('id', fx.distributorProduct.id)
      await serviceClient.from('hospital_prices').update({ purchase_price: 100, delivery_price: 150 }).eq('id', fx.hospitalPriceA.id)

      const { data: row } = await serviceClient
        .from('hospital_prices')
        .select('gross_profit, purchase_rate, delivery_rate')
        .eq('id', fx.hospitalPriceA.id)
        .single()
      expect(Number(row?.gross_profit)).toBe(50)
      expect(Number(row?.purchase_rate)).toBeCloseTo(0.5)
      expect(Number(row?.delivery_rate)).toBeCloseTo(0.75)

      await serviceClient.from('distributor_products').update({ reimbursement_price: 400 }).eq('id', fx.distributorProduct.id)
      const { data: after } = await serviceClient
        .from('hospital_prices')
        .select('purchase_rate, delivery_rate')
        .eq('id', fx.hospitalPriceA.id)
        .single()
      expect(Number(after?.purchase_rate)).toBeCloseTo(0.25)
      expect(Number(after?.delivery_rate)).toBeCloseTo(0.375)

      await serviceClient.from('distributor_products').update({ reimbursement_price: null }).eq('id', fx.distributorProduct.id)
      const { data: nulled } = await serviceClient
        .from('hospital_prices')
        .select('purchase_rate')
        .eq('id', fx.hospitalPriceA.id)
        .single()
      expect(nulled?.purchase_rate).toBeNull()
    })

    // WHY(2026-09-08): 上の it は **service_role でしか測っていない**。service_role は RLS を
    //      通らないので、I-040 の「**全施設の**掛け率が追従する」という約束の、実運用の経路は
    //      測れていない。propagate_reimbursement_price_change() は SECURITY DEFINER では
    //      **ない**ため、`UPDATE hospital_prices ... WHERE distributor_product_id = …` は
    //      呼んだ人の RLS で走る。RLS で見えない行は**エラーにならず黙って飛ばされ**、
    //      その施設だけ古い掛け率が残る（気づく手段が無い）。
    //      届く根拠は「償還価格を変えられるのは is_admin() だけ」かつ「is_admin() が
    //      施設をまたぐ（role='admin' がどこか 1 施設にあれば全体で真）」の 2 つだけなので、
    //      その 2 つを実ユーザーで測る。どちらかが施設単位に狭められたら、ここが落ちる。
    it('償還価格を変えられるのは admin だけで、その 1 回で自分が所属しない施設の掛け率まで追従する', async () => {
      // 施設 B にも同じ代理店商品の価格を作り、2 施設にまたがる状態にする
      const { data: priceB, error: priceBError } = await serviceClient
        .from('hospital_prices')
        .insert({
          distributor_product_id: fx.distributorProduct.id,
          facility_id: fx.facilityB.id,
          purchase_price: 100,
          delivery_price: 150,
        })
        .select('id')
        .single()
      expect(priceBError).toBeNull()

      await serviceClient
        .from('hospital_prices')
        .update({ purchase_price: 100, delivery_price: 150 })
        .eq('id', fx.hospitalPriceA.id)
      await serviceClient
        .from('distributor_products')
        .update({ reimbursement_price: 200 })
        .eq('id', fx.distributorProduct.id)

      // 施設 A にも B にも所属しない、第三の施設の admin を作る。
      // → is_facility_writer(A) も is_facility_writer(B) も false。届くとすれば is_admin() だけ。
      const facilityC = await createFacility(serviceClient, `テスト施設C-${randomUUID()}`)
      const admin = await createSeededUser(serviceClient, 'invariant-i040-admin', facilityC.id, 'admin')
      const staff = fx.userA // 施設 A の staff（admin ではない）

      try {
        // 1. staff は償還価格を変えられない（＝黙って一部だけ更新される経路自体が無い）
        const { data: staffUpdated, error: staffError } = await staff.client
          .from('distributor_products')
          .update({ reimbursement_price: 999 })
          .eq('id', fx.distributorProduct.id)
          .select('id')
        expect(staffError).toBeNull() // RLS の拒否はエラーではなく 0 行として返る
        expect(staffUpdated ?? []).toHaveLength(0)

        // 2. admin は変えられる
        const { data: adminUpdated, error: adminError } = await admin.client
          .from('distributor_products')
          .update({ reimbursement_price: 400 })
          .eq('id', fx.distributorProduct.id)
          .select('id')
        expect(adminError).toBeNull()
        expect(adminUpdated ?? []).toHaveLength(1)

        // 3. その 1 回で、admin が所属しない施設 A・B **両方**の掛け率が追従している
        const { data: rows } = await serviceClient
          .from('hospital_prices')
          .select('id, facility_id, purchase_rate, delivery_rate')
          .eq('distributor_product_id', fx.distributorProduct.id)
        const byFacility = new Map((rows ?? []).map((r) => [r.facility_id as string, r]))
        for (const facilityId of [fx.facilityA.id, fx.facilityB.id]) {
          const row = byFacility.get(facilityId)
          expect(row, `施設 ${facilityId} の価格行が見つからない`).toBeDefined()
          expect(Number(row!.purchase_rate), `施設 ${facilityId} の仕入れ掛け率が古いまま`).toBeCloseTo(0.25)
          expect(Number(row!.delivery_rate), `施設 ${facilityId} の納入掛け率が古いまま`).toBeCloseTo(0.375)
        }
      } finally {
        await serviceClient.from('hospital_prices').delete().eq('id', priceB!.id)
        await serviceClient.auth.admin.deleteUser(admin.id)
        await serviceClient.from('facilities').delete().eq('id', facilityC.id)
      }
    })
  })
})
