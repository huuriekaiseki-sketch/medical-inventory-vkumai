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

describe('業務不変条件（DB 制約・トリガー） [I-010 I-011 I-012 I-013 I-014 I-020 I-021 I-037 I-040 I-062]', () => {
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
  // WHY(2026-09-09 に測って閉じた): I-033 は「守る場所＝主キー」と書いたまま
  //      **守るテストが 未 で 計画のまま**だった。制約は最初からあるのに、
  //      誰も破ろうとしたことが無い＝「効いている」と言えない状態（C-011 の形）。
  //
  //      これは認可に直結する。同じ利用者が同じ施設に 2 行持てると、
  //      `is_facility_writer()` / `is_admin()` が**どちらの行を見るか**で結果が変わりうる
  //      （viewer の行と admin の行を同時に持てる）。
  describe('I-033 利用者は 1 施設に 1 行（同じ施設に二重所属しない）', () => {
    it('同じ組み合わせを 2 回入れると 23505。役割違いでも入らない', async () => {
      const { data: facility } = await serviceClient
        .from('facilities')
        .insert({ name: `二重所属テスト施設-${randomUUID()}` })
        .select('id')
        .single()
      const { data: created } = await serviceClient.auth.admin.createUser({
        email: `duplicate-membership-${randomUUID()}@example.test`,
        password: 'duplicate-membership-test-0000',
        email_confirm: true,
      })
      const userId = created!.user!.id

      const { error: first } = await serviceClient
        .from('user_facilities')
        .insert({ user_id: userId, facility_id: facility!.id, role: 'viewer' })
      expect(first, '1 行目が入らない（前提が崩れている）').toBeNull()

      // 同じ役割でも、違う役割でも 2 行目は入らない（主キーは role を含まない）
      const { error: sameRole } = await serviceClient
        .from('user_facilities')
        .insert({ user_id: userId, facility_id: facility!.id, role: 'viewer' })
      expect(sameRole?.code).toBe('23505')
      const { error: otherRole } = await serviceClient
        .from('user_facilities')
        .insert({ user_id: userId, facility_id: facility!.id, role: 'admin' })
      expect(otherRole?.code, '役割を変えれば二重に所属できてしまった').toBe('23505')

      // 対照: 別の施設へは入る（「何も入らない」で緑になっていないこと）
      const { data: other } = await serviceClient
        .from('facilities')
        .insert({ name: `二重所属テスト施設2-${randomUUID()}` })
        .select('id')
        .single()
      const { error: another } = await serviceClient
        .from('user_facilities')
        .insert({ user_id: userId, facility_id: other!.id, role: 'staff' })
      expect(another, '別の施設にも所属できない（制約が広すぎる）').toBeNull()

      await serviceClient.auth.admin.deleteUser(userId)
      await serviceClient.from('facilities').delete().in('id', [facility!.id, other!.id])
    })
  })

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

  // WHY(2026-09-18): I-021 も I-062 と同じ穴だった。カタログの 1 行が
  //      「発注 3 種・返却・返却明細・消耗品」の**6 表ぶんの CHECK をまとめて宣言**しているのに、
  //      実際に測っていたのは消耗品発注と消耗品の 2 表だけで、残り 4 表は
  //      「同じ形の CHECK だから大丈夫」という**推測のまま**だった（カタログの証拠欄にもそう書いてある）。
  //      表ごとに許す語彙が違う（発注は draft/submitted/cancelled、返却は draft/returned/cancelled、
  //      返却明細は active/cancelled）ので、1 表で測っても他の表の語彙が正しい保証にはならない。
  //
  // WHY(**UPDATE でなく INSERT で測る**、2026-09-18 の実測): 最初は既存行を未知の status へ
  //      UPDATE する形で書いたが、**CHECK を DROP しても 4 件とも緑のまま**だった。
  //      `<表>_status_forward_only`（BEFORE UPDATE OF status）が先に 23514 を返すためで、
  //      あの形は I-021（語彙の CHECK）ではなく **I-020（前進のみのトリガー）を測っていた**。
  //      トリガーは UPDATE にしか付かないので、未知の語彙を持つ行を直接 INSERT すれば CHECK に届く。
  //      この経路は「service_role の直接 INSERT でも止まる」を見る I-012 と同じ型。
  //      **対照（決めてある語彙なら INSERT が通る）を必ず置く**。片側だけだと
  //      「何も通さない CHECK」や「別の理由で失敗しているだけ」でも緑になる。
  describe('I-021 状態の語彙は決めた値だけ（残り 4 表。CHECK に届く INSERT 経路で測る）', () => {
    const caseOrderRow = (status: string) => ({
      facility_id: fx.facilityA.id,
      case_datetime: new Date().toISOString(),
      procedure_name: '状態語彙テスト',
      patient_id: 'PT-INV-STATUS',
      patient_initials: 'S.T.',
      gender: 'other',
      doctor_name: 'テスト医師',
      status,
    })

    it('症例発注: 未知の語彙は 23514、決めてある語彙は通る', async () => {
      const { error } = await serviceClient.from('case_orders').insert(caseOrderRow('shipped'))
      expect(error?.code).toBe(CHECK_VIOLATION)

      const { error: allowed } = await serviceClient.from('case_orders').insert(caseOrderRow('cancelled'))
      expect(allowed, '決めてある語彙が拒否された').toBeNull()
    })

    it('短貸発注: 未知の語彙は 23514、決めてある語彙は通る', async () => {
      const row = (status: string) => ({
        facility_id: fx.facilityA.id,
        procedure_name: '状態語彙テスト',
        maker: 'テストメーカー',
        status,
      })
      const { error } = await serviceClient.from('loan_orders').insert(row('shipped'))
      expect(error?.code).toBe(CHECK_VIOLATION)

      const { error: allowed } = await serviceClient.from('loan_orders').insert(row('cancelled'))
      expect(allowed, '決めてある語彙が拒否された').toBeNull()
    })

    // WHY(語彙が発注と違う): 返却は submitted を持たず returned を使う。
    //      「発注 3 種と同じ語彙だろう」という推測が誤りであることを実測で示す
    it('短貸返却: 未知の語彙は 23514。発注の submitted も返却では通らない', async () => {
      const row = (status: string) => ({
        facility_id: fx.facilityA.id,
        return_datetime: new Date().toISOString(),
        status,
      })
      const { error } = await serviceClient.from('loan_returns').insert(row('shipped'))
      expect(error?.code).toBe(CHECK_VIOLATION)

      const { error: orderWord } = await serviceClient.from('loan_returns').insert(row('submitted'))
      expect(orderWord?.code, '発注の語彙が返却で通ってしまった').toBe(CHECK_VIOLATION)

      const { error: allowed } = await serviceClient.from('loan_returns').insert(row('returned'))
      expect(allowed, '決めてある語彙が拒否された').toBeNull()
    })

    it('返却明細: 語彙は active / cancelled の 2 語だけ（発注の draft も通らない）', async () => {
      const { data: ret, error: retError } = await fx.userA.client.rpc('create_loan_return_atomic', {
        p_header: { facility_id: fx.facilityA.id, return_datetime: new Date().toISOString(), loan_order_id: null },
        p_items: [{ jan, lot: null, ubd: null, quantity: 1 }],
      })
      expect(retError).toBeNull()
      const returnId = (ret as { id: string }).id
      const row = (status: string) => ({ loan_return_id: returnId, jan, quantity: 1, status })

      const { error } = await serviceClient.from('loan_return_items').insert(row('returned'))
      expect(error?.code).toBe(CHECK_VIOLATION)

      const { error: draftWord } = await serviceClient.from('loan_return_items').insert(row('draft'))
      expect(draftWord?.code, '発注の語彙が返却明細で通ってしまった').toBe(CHECK_VIOLATION)

      const { error: allowed } = await serviceClient.from('loan_return_items').insert(row('cancelled'))
      expect(allowed, '決めてある語彙が拒否された').toBeNull()
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

  // WHY(2026-09-10、統合テストの後片付けを機械で測って見つけた): 契約 O-052 は
  //      「代理店商品は admin + aal2 が消せる」だが、**仕切値を一度でも変えた商品は
  //      誰にも消せなかった**（`price_histories` からの FK が ON DELETE 指定なしで、
  //      履歴は GRANT が SELECT のみなので先に消すこともできない）。
  //      院内価格側（20260906000007）と同じ規則を親の反対側にも入れた。
  //      **両方向で測る**: 履歴があっても消せること（本題）と、
  //      消した後に履歴が 1 行も残らないこと（孤児にしない）。
  describe('I-037 代理店商品を消すと、その仕切値の履歴が残らない', () => {
    /** 製品・カテゴリ・代理店商品を 1 組作り、仕切値を変えて履歴を 1 行以上作る */
    async function seedWithHistory() {
      const suffix = randomUUID()
      const { data: product, error: productError } = await serviceClient
        .from('products')
        .insert({ jan: `i037-jan-${suffix}`, ref: `i037-ref-${suffix}`, name: `I-037 製品-${suffix}` })
        .select('id')
        .single()
      if (productError || !product) throw new Error(`[I-037] products: ${productError?.message}`)
      const { data: category, error: categoryError } = await serviceClient
        .from('categories')
        .insert({ name: `I-037 カテゴリ-${suffix}` })
        .select('id')
        .single()
      if (categoryError || !category) throw new Error(`[I-037] categories: ${categoryError?.message}`)
      const { data: dp, error: dpError } = await serviceClient
        .from('distributor_products')
        .insert({
          product_id: product.id, category_id: category.id, maker: 'm', supplier: 's',
          name: `I-037 代理店商品-${suffix}`, reimbursement_price: 100, quantity: 1,
        })
        .select('id')
        .single()
      if (dpError || !dp) throw new Error(`[I-037] distributor_products: ${dpError?.message}`)

      // 履歴は**値が変わったときだけ** 1 行増える（I-041）。変えないと餌が無いまま測ることになる
      const { error: reviseError } = await serviceClient
        .from('distributor_products').update({ reimbursement_price: 200 }).eq('id', dp.id)
      if (reviseError) throw new Error(`[I-037] 改定: ${reviseError.message}`)

      const { count } = await serviceClient
        .from('price_histories').select('*', { count: 'exact', head: true }).eq('distributor_product_id', dp.id)
      // 対照（C-021）: 履歴が 0 件のまま「消せた」と言っても何も測っていない
      expect(count ?? 0, '仕切値の履歴が 1 行も生まれていない（測る餌が無い）').toBeGreaterThan(0)

      return { productId: product.id as string, categoryId: category.id as string, dpId: dp.id as string }
    }

    it('履歴がある代理店商品を消せる（消せなかったのが実害）', async () => {
      const { productId, categoryId, dpId } = await seedWithHistory()

      const { error } = await serviceClient.from('distributor_products').delete().eq('id', dpId)
      expect(error, `履歴があると消せない（${JSON.stringify(error)}）`).toBeNull()

      const { count } = await serviceClient
        .from('price_histories').select('*', { count: 'exact', head: true }).eq('distributor_product_id', dpId)
      expect(count ?? 0, '親が消えたのに履歴が残っている（孤児）').toBe(0)

      await serviceClient.from('products').delete().eq('id', productId)
      await serviceClient.from('categories').delete().eq('id', categoryId)
    })

    it('緩い参照（entity_type / entity_id）の履歴も残らない', async () => {
      const { productId, categoryId, dpId } = await seedWithHistory()

      await serviceClient.from('distributor_products').delete().eq('id', dpId)
      const { count } = await serviceClient
        .from('price_histories')
        .select('*', { count: 'exact', head: true })
        .eq('entity_type', 'distributor_product')
        .eq('entity_id', dpId)
      expect(count ?? 0, 'entity_id 側の履歴が孤児として残っている').toBe(0)

      await serviceClient.from('products').delete().eq('id', productId)
      await serviceClient.from('categories').delete().eq('id', categoryId)
    })

    it('別の代理店商品の履歴は巻き込まない（消しすぎない。C-030）', async () => {
      const a = await seedWithHistory()
      const b = await seedWithHistory()

      await serviceClient.from('distributor_products').delete().eq('id', a.dpId)

      const { count } = await serviceClient
        .from('price_histories').select('*', { count: 'exact', head: true }).eq('distributor_product_id', b.dpId)
      expect(count ?? 0, '関係の無い商品の履歴まで消えている').toBeGreaterThan(0)

      await serviceClient.from('distributor_products').delete().eq('id', b.dpId)
      await serviceClient.from('products').delete().in('id', [a.productId, b.productId])
      await serviceClient.from('categories').delete().in('id', [a.categoryId, b.categoryId])
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

    // WHY(2026-09-09): 消耗品に使用停止（`retired`）を足した。**同じ汎用トリガーを付けただけでは
    //      進めない**（この関数は元々 `draft` からしか動かせず、終端の語彙は `cancelled` だけだった）。
    //      「付けたから効くはず」で終わらせず、進む向きと戻る向きの両方を実測する（C-022）。
    it('consumables: active → retired は通り、retired → active は service_role でも 23514', async () => {
      const { data: consumable } = await serviceClient
        .from('consumables')
        .insert({ facility_id: fx.facilityA.id, name: '使用停止テスト消耗品', purpose: 'test' })
        .select('id, status')
        .single()
      expect(consumable?.status).toBe('active')

      const { error: forward } = await serviceClient.from('consumables').update({ status: 'retired' }).eq('id', consumable!.id)
      expect(forward, '使用停止にできない（前へ進めない）').toBeNull()

      const { error: backward } = await serviceClient.from('consumables').update({ status: 'active' }).eq('id', consumable!.id)
      expect(backward?.code).toBe(CHECK_VIOLATION)

      const { data: after } = await serviceClient.from('consumables').select('status').eq('id', consumable!.id).single()
      expect(after?.status).toBe('retired')

      // WHY(語彙の対照): 決めていない状態へは進めない（I-021 と同じ形）
      const { data: other } = await serviceClient
        .from('consumables')
        .insert({ facility_id: fx.facilityA.id, name: '語彙テスト消耗品', purpose: 'test' })
        .select('id')
        .single()
      const { error: unknownStatus } = await serviceClient.from('consumables').update({ status: 'archived' }).eq('id', other!.id)
      expect(unknownStatus?.code).toBe(CHECK_VIOLATION)
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
