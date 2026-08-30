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
  facilityId: string,
  /** 既定は staff（従来の呼び出し側の挙動を変えない）。is_admin() は role='admin' で真になる */
  role: 'staff' | 'admin' | 'viewer' = 'staff'
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
    .insert({ user_id: userId, facility_id: facilityId, role })
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

export interface SeedLoanReturnsRlsIdorFixtures {
  facilityA: { id: string; name: string }
  facilityB: { id: string; name: string }
  userA: SeededUser
  userB: SeededUser
  loanReturnA: { id: string }
}

/**
 * 施設A・施設B、ユーザーA（施設Aのみ）・ユーザーB（施設Bのみ）、
 * 施設Aに紐づく loan_returns 1件を作成する（loan_orders/case_orders/
 * consumable_ordersと同様の横展開。facility_member_or_admin RLSポリシーの
 * テーブル単体検証がloan_returnsだけ欠落していたため追加）。
 */
export async function seedLoanReturnsRlsIdorFixtures(): Promise<SeedLoanReturnsRlsIdorFixtures> {
  const serviceClient = createServiceRoleClient()
  const runId = randomUUID()

  const facilityA = await createFacility(serviceClient, `テスト施設A-${runId}`)
  const facilityB = await createFacility(serviceClient, `テスト施設B-${runId}`)

  const userA = await createSeededUser(serviceClient, 'rls-idor-loan-return-user-a', facilityA.id)
  const userB = await createSeededUser(serviceClient, 'rls-idor-loan-return-user-b', facilityB.id)

  // シード用の1件は service role client（RLSをバイパスする）で直接作成する。
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
    loanReturnA: { id: loanReturn.id as string },
  }
}

export async function cleanupLoanReturnsRlsIdorFixtures(fixtures: SeedLoanReturnsRlsIdorFixtures): Promise<void> {
  await cleanupFacilitiesAndUsers(fixtures.userA, fixtures.userB, fixtures.facilityA, fixtures.facilityB)
}

export interface SeedOrderItemsRlsIdorFixtures {
  facilityA: { id: string; name: string }
  facilityB: { id: string; name: string }
  userA: SeededUser
  userB: SeededUser
  /** 施設Aの親（明細のRLSはこの親経由のEXISTSで効く） */
  parents: { caseOrderId: string; consumableOrderId: string; loanReturnId: string }
  /** 施設Aの明細1件ずつ */
  items: { caseOrderItemId: string; consumableOrderItemId: string; loanReturnItemId: string }
  /** 明細をこの親にぶら下げようとする＝施設Aへの書き込みになる（insert検証用） */
  consumableId: string
  /** case_order_items.jan / loan_return_items.jan は products.jan へのFK */
  jan: string
  productId: string
}

/**
 * 施設A・施設B、それぞれのユーザー、および施設Aの
 * case_order_items / consumable_order_items / loan_return_items を1件ずつ作成する。
 *
 * WHY: これら3つの明細テーブルは **facility_id 列を持たない**。
 *      施設境界は親テーブル経由の `EXISTS (... is_facility_member(o.facility_id) ...)`
 *      で守られている（supabase/migrations/20260628010001_update_rls_admin.sql:71/85/113）。
 *      親（case_orders / consumable_orders / loan_returns）にはIDOR統合テストがあるのに、
 *      **子の明細には無かった**（`findRlsTablesWithoutIdorTest` の検知で発覚）。
 *      親が守られていることは子が守られていることを意味しない。子は親をJOINせずに
 *      直接叩けるため、独立した検証が要る。
 *      `loan_order_items` だけは既にテストがあり、同型3件の横展開漏れだった。
 */
export async function seedOrderItemsRlsIdorFixtures(): Promise<SeedOrderItemsRlsIdorFixtures> {
  const serviceClient = createServiceRoleClient()
  const runId = randomUUID()

  const facilityA = await createFacility(serviceClient, `テスト施設A-${runId}`)
  const facilityB = await createFacility(serviceClient, `テスト施設B-${runId}`)

  const userA = await createSeededUser(serviceClient, 'rls-idor-order-items-user-a', facilityA.id)
  const userB = await createSeededUser(serviceClient, 'rls-idor-order-items-user-b', facilityB.id)

  const insertOne = async <T extends string>(table: T, row: Record<string, unknown>) => {
    const { data, error } = await serviceClient.from(table).insert(row).select('id').single()
    if (error || !data) {
      throw new Error(`[seed-rls-idor] ${table} シード作成失敗: ${error?.message}`)
    }
    return data.id as string
  }

  const caseOrderId = await insertOne('case_orders', {
    facility_id: facilityA.id,
    case_datetime: new Date().toISOString(),
    procedure_name: 'シード用術式',
    patient_id: 'IDOR-TEST-PATIENT-0000',
    patient_initials: 'IDORテスト患者',
    gender: 'other',
    doctor_name: 'IDORテスト医師',
  })
  const consumableOrderId = await insertOne('consumable_orders', { facility_id: facilityA.id })
  const loanReturnId = await insertOne('loan_returns', {
    facility_id: facilityA.id,
    return_datetime: new Date().toISOString(),
  })
  const consumableId = await insertOne('consumables', {
    facility_id: facilityA.id,
    name: `シード用消耗品-${runId}`,
    purpose: 'IDORテスト',
  })

  // case_order_items.jan / loan_return_items.jan は products.jan へのFK
  // （20260714000004_link_consumables_jan_and_validate_fk.sql）。実在する製品が要る
  const jan = `jan-items-${runId}`
  const productId = await insertOne('products', {
    jan,
    ref: `ref-items-${runId}`,
    name: `シード用製品-${runId}`,
  })

  const caseOrderItemId = await insertOne('case_order_items', {
    case_order_id: caseOrderId,
    jan,
    quantity: 1,
  })
  const consumableOrderItemId = await insertOne('consumable_order_items', {
    consumable_order_id: consumableOrderId,
    consumable_id: consumableId,
    quantity: 1,
  })
  const loanReturnItemId = await insertOne('loan_return_items', {
    loan_return_id: loanReturnId,
    jan,
    quantity: 1,
  })

  return {
    facilityA,
    facilityB,
    userA,
    userB,
    parents: { caseOrderId, consumableOrderId, loanReturnId },
    items: { caseOrderItemId, consumableOrderItemId, loanReturnItemId },
    consumableId,
    jan,
    productId,
  }
}

export async function cleanupOrderItemsRlsIdorFixtures(
  fixtures: SeedOrderItemsRlsIdorFixtures
): Promise<void> {
  const serviceClient = createServiceRoleClient()
  // facilities の削除で親（case_orders等）が消え、明細もCASCADEで消える。
  // products は施設に紐づかないので個別に消す（明細が消えた後でないとFKで残る）
  await cleanupFacilitiesAndUsers(fixtures.userA, fixtures.userB, fixtures.facilityA, fixtures.facilityB)
  await serviceClient.from('products').delete().eq('id', fixtures.productId)
}

export interface SeedPriceHistoriesFixtures extends SeedHospitalPricesRlsIdorFixtures {
  /** entity_type='hospital_price'（施設Aの価格の履歴＝施設Bから見えてはいけない） */
  facilityScopedHistory: { id: string }
  /** entity_type='distributor_product'（マスタの履歴＝全員が見てよい。設計どおり） */
  masterHistory: { id: string }
}

/**
 * price_histories の RLS/CHECK 検証用シード。hospital_prices のシードを土台にする。
 *
 * WHY: price_histories はポリモーフィックで、entity_type によって施設スコープの
 *      有無が変わる（20260628010001_update_rls_admin.sql:130）。
 *        - 'hospital_price'      → 親 hospital_prices の施設をチェック（＝施設スコープあり）
 *        - 'distributor_product' → true（＝マスタなので全員可）
 *      施設ごとの仕入価格の**変更履歴**であり、現在値と同じ機微度を持つのに
 *      RLS/IDOR統合テストもCHECK制約の実DB検証も無かった。
 *      INSERT はトリガー（SECURITY DEFINER）経由のみで、シードは service role で行う。
 */
export async function seedPriceHistoriesFixtures(): Promise<SeedPriceHistoriesFixtures> {
  const serviceClient = createServiceRoleClient()
  const base = await seedHospitalPricesRlsIdorFixtures()

  // price_histories への直接INSERTは service_role でも不可（GRANT が SELECT のみ）。
  // 履歴は SECURITY DEFINER トリガー経由でしか作られないため、親を実際に更新して作る。
  // 結果として「本番と同じ経路」でシードすることになる。
  const findHistory = async (entityType: string, entityId: string) => {
    const { data, error } = await serviceClient
      .from('price_histories')
      .select('id')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .limit(1)
      .single()
    if (error || !data) {
      throw new Error(
        `[seed-rls-idor] price_histories がトリガーで作られていない (${entityType}): ${error?.message}`
      )
    }
    return { id: data.id as string }
  }

  const { error: hpUpdateError } = await serviceClient
    .from('hospital_prices')
    .update({ purchase_price: base.hospitalPriceA.purchasePrice + 1 })
    .eq('id', base.hospitalPriceA.id)
  if (hpUpdateError) {
    throw new Error(`[seed-rls-idor] hospital_prices 更新失敗: ${hpUpdateError.message}`)
  }

  const { error: dpUpdateError } = await serviceClient
    .from('distributor_products')
    .update({ reimbursement_price: 999 })
    .eq('id', base.distributorProduct.id)
  if (dpUpdateError) {
    throw new Error(`[seed-rls-idor] distributor_products 更新失敗: ${dpUpdateError.message}`)
  }

  const facilityScopedHistory = await findHistory('hospital_price', base.hospitalPriceA.id)
  const masterHistory = await findHistory('distributor_product', base.distributorProduct.id)

  return { ...base, facilityScopedHistory, masterHistory }
}

export async function cleanupPriceHistoriesFixtures(
  fixtures: SeedPriceHistoriesFixtures
): Promise<void> {
  const serviceClient = createServiceRoleClient()
  // price_histories は hospital_prices/distributor_products へのCASCADEを持たない
  // （FKは NOT VALID で ON DELETE 指定なし）ため、先に自分で消す
  await serviceClient
    .from('price_histories')
    .delete()
    .eq('distributor_product_id', fixtures.distributorProduct.id)
  await cleanupHospitalPricesRlsIdorFixtures(fixtures)
}

export interface SeedAdminBoundaryFixtures {
  facility: { id: string; name: string }
  /** role='admin'。is_admin() が真になる */
  adminUser: SeededUser
  /** role='staff'。施設のメンバーだが admin ではない */
  staffUser: SeededUser
  /** 既存行の更新・削除を試すための種 */
  existing: { categoryId: string; productId: string; distributorProductId: string }
  /**
   * product_compatibilities の insert検証用。UUID辞書順で small < large に整列済み。
   * WHY: 同じ製品IDを2つ渡すと `no_self_compat` CHECK で**誰が呼んでも失敗**し、
   *      「adminでないから拒否された」ことを検証できない（実際にこの罠を踏んだ）。
   *      逆順でも `ordered_pair` CHECK で同様に失敗するため、正しい順序で渡す。
   */
  compatPair: { small: string; large: string }
  productId2: string
  runId: string
}

/**
 * admin境界（adminだけが書けるマスタ）の検証用シード。
 *
 * WHY: categories / distributor_products / products / product_compatibilities / facilities は
 *      SELECT が `USING (true)`（テナント非分離）で、書き込みだけが `is_admin()` に限定される。
 *      施設境界の約束が無いのでIDOR軸からは除外したが、**代わりに admin 境界という別の
 *      約束がある**。そこを一度も試していなかった（`findAdminOnlyTablesWithoutTest` で発覚）。
 *      is_admin() は user_facilities.role='admin' を見るだけなので、シードは role 違いの
 *      ユーザーを2人作るだけでよい。
 */
export async function seedAdminBoundaryFixtures(): Promise<SeedAdminBoundaryFixtures> {
  const serviceClient = createServiceRoleClient()
  const runId = randomUUID()

  const facility = await createFacility(serviceClient, `テスト施設-${runId}`)
  const adminUser = await createSeededUser(serviceClient, 'admin-boundary-admin', facility.id, 'admin')
  const staffUser = await createSeededUser(serviceClient, 'admin-boundary-staff', facility.id, 'staff')

  const insertOne = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await serviceClient.from(table).insert(row).select('id').single()
    if (error || !data) {
      throw new Error(`[seed-rls-idor] ${table} シード作成失敗: ${error?.message}`)
    }
    return data.id as string
  }

  const categoryId = await insertOne('categories', { name: `admin境界テストカテゴリ-${runId}` })
  const productId = await insertOne('products', {
    jan: `jan-admin-${runId}`,
    ref: `ref-admin-${runId}`,
    name: `admin境界テスト製品-${runId}`,
  })
  const distributorProductId = await insertOne('distributor_products', {
    product_id: productId,
    category_id: categoryId,
    maker: 'テストメーカー',
    supplier: 'テスト販売業者',
    name: `admin境界テスト取扱商品-${runId}`,
  })

  // product_compatibilities の insert検証には**別の製品**が要る（自己参照禁止のため）
  const productId2 = await insertOne('products', {
    jan: `jan-admin2-${runId}`,
    ref: `ref-admin2-${runId}`,
    name: `admin境界テスト製品2-${runId}`,
  })
  const [small, large] =
    productId < productId2 ? [productId, productId2] : [productId2, productId]

  return {
    facility,
    adminUser,
    staffUser,
    existing: { categoryId, productId, distributorProductId },
    compatPair: { small, large },
    productId2,
    runId,
  }
}

export async function cleanupAdminBoundaryFixtures(
  fixtures: SeedAdminBoundaryFixtures
): Promise<void> {
  const serviceClient = createServiceRoleClient()
  await serviceClient.auth.admin.deleteUser(fixtures.adminUser.id)
  await serviceClient.auth.admin.deleteUser(fixtures.staffUser.id)
  await serviceClient.from('facilities').delete().eq('id', fixtures.facility.id)
  // products の削除で distributor_products / product_compatibilities も CASCADE で消える
  await serviceClient
    .from('products')
    .delete()
    .in('id', [fixtures.existing.productId, fixtures.productId2])
  await serviceClient.from('categories').delete().eq('id', fixtures.existing.categoryId)
  // adminが対照テストで作った行（名前に runId を含む）も後始末する
  await serviceClient.from('categories').delete().like('name', `%${fixtures.runId}%`)
}

export interface SeedProductCompatibilitiesFixtures {
  categoryA: { id: string }
  categoryB: { id: string }
  /** UUID文字列の辞書順で small < large になるよう並べ替え済み */
  productSmall: { id: string }
  productLarge: { id: string }
}

/**
 * product_compatibilities のDB制約検証用に、カテゴリ2件と製品2件を作成する。
 *
 * WHY: product_compatibilities は CHECK 2つ・複合UNIQUE・FK 3つを持ちながら、
 *      実DBでの検証が一度も無かった（`findUncoveredConstraintMigrations` の検知で発覚）。
 *      特に `ordered_pair CHECK (product_id_1 < product_id_2)` は「(a,b)と(b,a)を
 *      同一視する」という効きの強い不変条件で、静的SQL検証では
 *      「その文字列が書いてある」ことしか確かめられない。
 *      制約はRLSと異なり service role でもバイパスされないため、ユーザーは不要。
 */
export async function seedProductCompatibilitiesFixtures(): Promise<SeedProductCompatibilitiesFixtures> {
  const serviceClient = createServiceRoleClient()
  const runId = randomUUID()

  const insertCategory = async (suffix: string) => {
    const { data, error } = await serviceClient
      .from('categories')
      .insert({ name: `テストカテゴリ${suffix}-${runId}` })
      .select('id')
      .single()
    if (error || !data) {
      throw new Error(`[seed-rls-idor] categories シード作成失敗: ${error?.message}`)
    }
    return { id: data.id as string }
  }

  const insertProduct = async (suffix: string) => {
    const { data, error } = await serviceClient
      .from('products')
      .insert({
        jan: `jan-compat-${suffix}-${runId}`,
        ref: `ref-compat-${suffix}-${runId}`,
        name: `テスト製品${suffix}-${runId}`,
      })
      .select('id')
      .single()
    if (error || !data) {
      throw new Error(`[seed-rls-idor] products シード作成失敗: ${error?.message}`)
    }
    return { id: data.id as string }
  }

  const categoryA = await insertCategory('A')
  const categoryB = await insertCategory('B')
  const p1 = await insertProduct('1')
  const p2 = await insertProduct('2')

  // ordered_pair CHECK は UUID の大小比較なので、採番結果に依存せず
  // 「小さい方」「大きい方」を確定させておく
  const [productSmall, productLarge] = p1.id < p2.id ? [p1, p2] : [p2, p1]

  return { categoryA, categoryB, productSmall, productLarge }
}

export async function cleanupProductCompatibilitiesFixtures(
  fixtures: SeedProductCompatibilitiesFixtures
): Promise<void> {
  const serviceClient = createServiceRoleClient()
  // products / categories の削除で product_compatibilities は CASCADE で消える
  await serviceClient
    .from('products')
    .delete()
    .in('id', [fixtures.productSmall.id, fixtures.productLarge.id])
  await serviceClient
    .from('categories')
    .delete()
    .in('id', [fixtures.categoryA.id, fixtures.categoryB.id])
}

export interface SeedHospitalPricesRlsIdorFixtures {
  facilityA: { id: string; name: string }
  facilityB: { id: string; name: string }
  userA: SeededUser
  userB: SeededUser
  distributorProduct: { id: string }
  /**
   * insert検証専用の別商品。
   * WHY: hospital_prices は unique(distributor_product_id, facility_id) を持つため、
   *      シード済みと同じ組み合わせでinsertを試すと**誰が呼んでもUNIQUE違反**になり、
   *      「RLSで拒否された」ことを検証できない（実際にこの罠を踏んだ）。
   *      未使用の組み合わせを使うことで、拒否の理由をRLSに限定する。
   */
  distributorProductForInsert: { id: string }
  /** 後始末用（facilities のCASCADEでは消えないマスタ系） */
  masters: { productId: string; categoryId: string }
  hospitalPriceA: { id: string; purchasePrice: number }
}

/**
 * 施設A・施設B、それぞれのユーザー、および施設Aの hospital_prices 1件を作成する。
 *
 * WHY: hospital_prices は「施設ごとの購入価格・納入価格」という、施設をまたいで
 *      漏れてはいけない代表的なデータでありながら、RLS/IDOR統合テストが欠落していた
 *      （`findRlsTablesWithoutIdorTest` の検知で発覚）。
 *      hospital_prices は distributor_products → products / categories を必要とするため、
 *      他のシードより前提マスタが1段深い。
 */
export async function seedHospitalPricesRlsIdorFixtures(): Promise<SeedHospitalPricesRlsIdorFixtures> {
  const serviceClient = createServiceRoleClient()
  const runId = randomUUID()

  const facilityA = await createFacility(serviceClient, `テスト施設A-${runId}`)
  const facilityB = await createFacility(serviceClient, `テスト施設B-${runId}`)

  const userA = await createSeededUser(serviceClient, 'rls-idor-hospital-price-user-a', facilityA.id)
  const userB = await createSeededUser(serviceClient, 'rls-idor-hospital-price-user-b', facilityB.id)

  const { data: category, error: categoryError } = await serviceClient
    .from('categories')
    .insert({ name: `テストカテゴリ-${runId}` })
    .select('id')
    .single()
  if (categoryError || !category) {
    throw new Error(`[seed-rls-idor] categories シード作成失敗: ${categoryError?.message}`)
  }

  const { data: product, error: productError } = await serviceClient
    .from('products')
    .insert({ jan: `jan-${runId}`, ref: `ref-${runId}`, name: `テスト製品-${runId}` })
    .select('id')
    .single()
  if (productError || !product) {
    throw new Error(`[seed-rls-idor] products シード作成失敗: ${productError?.message}`)
  }

  const { data: distributorProduct, error: dpError } = await serviceClient
    .from('distributor_products')
    .insert({
      product_id: product.id as string,
      category_id: category.id as string,
      maker: 'テストメーカー',
      supplier: 'テスト販売業者',
      name: `テスト取扱商品-${runId}`,
    })
    .select('id')
    .single()
  if (dpError || !distributorProduct) {
    throw new Error(`[seed-rls-idor] distributor_products シード作成失敗: ${dpError?.message}`)
  }

  const { data: dpForInsert, error: dpForInsertError } = await serviceClient
    .from('distributor_products')
    .insert({
      product_id: product.id as string,
      category_id: category.id as string,
      maker: 'テストメーカー',
      supplier: 'テスト販売業者',
      name: `テスト取扱商品(insert検証用)-${runId}`,
    })
    .select('id')
    .single()
  if (dpForInsertError || !dpForInsert) {
    throw new Error(
      `[seed-rls-idor] distributor_products(insert検証用) シード作成失敗: ${dpForInsertError?.message}`
    )
  }

  // 施設Aの価格。施設Bのユーザーからは一切見えてはいけない値。
  const purchasePrice = 12345
  const { data: hospitalPrice, error: hpError } = await serviceClient
    .from('hospital_prices')
    .insert({
      distributor_product_id: distributorProduct.id as string,
      facility_id: facilityA.id,
      purchase_price: purchasePrice,
      delivery_price: 23456,
    })
    .select('id')
    .single()
  if (hpError || !hospitalPrice) {
    throw new Error(`[seed-rls-idor] hospital_prices シード作成失敗: ${hpError?.message}`)
  }

  return {
    facilityA,
    facilityB,
    userA,
    userB,
    distributorProduct: { id: distributorProduct.id as string },
    distributorProductForInsert: { id: dpForInsert.id as string },
    masters: { productId: product.id as string, categoryId: category.id as string },
    hospitalPriceA: { id: hospitalPrice.id as string, purchasePrice },
  }
}

export async function cleanupHospitalPricesRlsIdorFixtures(
  fixtures: SeedHospitalPricesRlsIdorFixtures
): Promise<void> {
  const serviceClient = createServiceRoleClient()
  // facilities の削除で hospital_prices は CASCADE で消えるが、
  // products / categories は施設に紐づかないため個別に消す（products の削除で
  // distributor_products も CASCADE で消える）
  await cleanupFacilitiesAndUsers(fixtures.userA, fixtures.userB, fixtures.facilityA, fixtures.facilityB)
  await serviceClient.from('products').delete().eq('id', fixtures.masters.productId)
  await serviceClient.from('categories').delete().eq('id', fixtures.masters.categoryId)
}
