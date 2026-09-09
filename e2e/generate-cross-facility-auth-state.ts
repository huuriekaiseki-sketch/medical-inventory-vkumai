// e2e/generate-cross-facility-auth-state.ts
// WHY: issue #321（issue #315の後半として切り出し）。
//      施設Bのユーザーが施設Aの発注データをUI上で閲覧できないことを検証するには、
//      2ユーザー×2施設の認証済みPlaywright storageStateが必要。既存の
//      generate-auth-state.tsは固定の単一テストユーザー用のため、こちらは
//      supabase/__tests__/integration/helpers/seed-rls-idor.tsと同様の方式で
//      施設A・施設B、それぞれに所属するユーザーA・ユーザーBを都度作成し、
//      施設Aにloan_orders 1件をシードする。

import { createClient } from '@supabase/supabase-js'
import { loadEnvConfig } from '@next/env'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { assertTestSupabaseEnv } from './env-guard'
import { signInAndSaveStorageState } from './generate-auth-state'

;(process.env as Record<string, string>).NODE_ENV = 'test'
loadEnvConfig(process.cwd())
assertTestSupabaseEnv()

export interface CrossFacilityFixtures {
  facilityAId: string
  facilityBId: string
  loanOrderProcedureName: string
  /** 施設 A にシードした短貸発注の ID（api-cross-facility-attack.spec.ts が path / body に入れて攻撃する。P-017） */
  loanOrderId?: string
  /**
   * 明細に入れられる、実在する製品の JAN。
   *
   * WHY(2026-09-08 追加): `case_order_items` / `loan_order_items` / `loan_return_items` の
   *      `jan` は `products.jan` への外部キー（`*_jan_fkey`）。**未登録の JAN では明細を作れない**
   *      ので、発注・返却の正常系を画面から測るには実在する製品が要る。
   *      既存の製品を探して使うと DB の中身にテストが依存するため、実行ごとに 1 件作る。
   */
  productJan?: string
  /** 施設 A の名前。ダッシュボードで「その施設の行」を特定するために使う */
  facilityAName?: string
  /**
   * 代理店商品の名前と ID。
   *
   * WHY(2026-09-08 追加): 院内価格は「施設 × 代理店商品」に付ける値なので、
   *      画面から登録するには代理店商品が 1 件以上要る（無いとフォームの送信ボタンが押せない）。
   *      既存のものを探して使うと DB の中身にテストが依存するため、実行ごとに 1 件作る。
   */
  distributorProductName?: string
  distributorProductId?: string
  /**
   * 施設 A の院内価格と、その**改定後**の仕切値（2026-09-09 追加）。
   *
   * WHY: 価格履歴の route（`/api/distributor-products/[id]/price-history`）は
   *      攻撃表で **weak**（存在しない UUID を渡すので 404 止まり）だった。
   *      施設 A の履歴を実際に作ることで、施設 B の利用者で叩いたときに
   *      「他施設の価格・施設名が本文に出ないか」を本当に測れるようになる。
   *      `facilityAPurchasePrice` は漏洩の目印に使うので、他と衝突しない値にしてある。
   */
  facilityAHospitalPriceId?: string
  facilityAPurchasePrice?: number
  /**
   * 攻撃の総当たり（P-017）が `[id]` に入れる、**実在するマスタの行**（2026-09-09 追加）。
   *
   * WHY: 攻撃表は長らく多くの route を **weak**（存在しない UUID を渡すので 404 止まり、
   *      あるいは本文が入口の検証に落ちて 400 止まり）として扱っており、
   *      **認可の判定に一度も到達していなかった**。実在する行を渡して初めて
   *      「施設 B の staff はマスタを読めるが変えられない」を実際に測れる（P-021 / P-033）。
   */
  productId?: string
  secondProductId?: string
  categoryId?: string
  compatibilityId?: string
  /**
   * 施設 A の返却と、その明細（2026-09-09 追加）。
   *
   * WHY: 品目ごとの取り消し（`/api/loan-returns/[id]/items/[itemId]`）を攻撃表で測るには、
   *      **実在する返却と明細**が要る。存在しない UUID では 404 で止まり、
   *      認可の判定に一度も届かない（weak）。
   *      紐付け（`loan_order_item_id`）は付けないので、他の spec の残数・未返却には影響しない。
   */
  loanReturnId?: string
  loanReturnItemId?: string
}

export const CROSS_FACILITY_FIXTURES_PATH = path.join(process.cwd(), 'e2e', '.auth', 'cross-facility-fixtures.json')
export const CROSS_FACILITY_USER_A_AUTH_PATH = path.join(process.cwd(), 'e2e', '.auth', 'cross-facility-user-a.json')
export const CROSS_FACILITY_USER_B_AUTH_PATH = path.join(process.cwd(), 'e2e', '.auth', 'cross-facility-user-b.json')

/** cross-facility-boundary.spec.ts から読む。フィクスチャが無ければnull（specはskipする）。 */
export function readCrossFacilityFixtures(): CrossFacilityFixtures | null {
  if (!fs.existsSync(CROSS_FACILITY_FIXTURES_PATH)) return null
  return JSON.parse(fs.readFileSync(CROSS_FACILITY_FIXTURES_PATH, 'utf-8')) as CrossFacilityFixtures
}

export async function generateCrossFacilityAuthState(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  fs.mkdirSync(path.dirname(CROSS_FACILITY_FIXTURES_PATH), { recursive: true })

  if (!supabaseUrl || !serviceRoleKey) {
    console.warn(
      '[E2E cross-facility auth] SUPABASE_SERVICE_ROLE_KEY 等が未設定。' +
        'cross-facility-boundary.spec.ts はフィクスチャ不在としてskipされます。'
    )
    return
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const runId = randomUUID()

  const facilityAName = `テスト施設A-${runId}`
  const { data: facilityA, error: facilityAError } = await supabase
    .from('facilities')
    .insert({ name: facilityAName })
    .select('id')
    .single()
  if (facilityAError || !facilityA) {
    throw new Error(`[E2E cross-facility auth] 施設A作成失敗: ${facilityAError?.message}`)
  }

  const { data: facilityB, error: facilityBError } = await supabase
    .from('facilities')
    .insert({ name: `テスト施設B-${runId}` })
    .select('id')
    .single()
  if (facilityBError || !facilityB) {
    throw new Error(`[E2E cross-facility auth] 施設B作成失敗: ${facilityBError?.message}`)
  }

  const emailA = `e2e-cross-facility-user-a-${runId}@example.test`
  const emailB = `e2e-cross-facility-user-b-${runId}@example.test`

  const { data: userAData, error: userAError } = await supabase.auth.admin.createUser({
    email: emailA,
    email_confirm: true,
  })
  if (userAError || !userAData.user) {
    throw new Error(`[E2E cross-facility auth] ユーザーA作成失敗: ${userAError?.message}`)
  }

  const { data: userBData, error: userBError } = await supabase.auth.admin.createUser({
    email: emailB,
    email_confirm: true,
  })
  if (userBError || !userBData.user) {
    throw new Error(`[E2E cross-facility auth] ユーザーB作成失敗: ${userBError?.message}`)
  }

  const { error: linkAError } = await supabase
    .from('user_facilities')
    .insert({ user_id: userAData.user.id, facility_id: facilityA.id, role: 'staff' })
  if (linkAError) {
    throw new Error(`[E2E cross-facility auth] ユーザーAの施設紐付け失敗: ${linkAError.message}`)
  }

  const { error: linkBError } = await supabase
    .from('user_facilities')
    .insert({ user_id: userBData.user.id, facility_id: facilityB.id, role: 'staff' })
  if (linkBError) {
    throw new Error(`[E2E cross-facility auth] ユーザーBの施設紐付け失敗: ${linkBError.message}`)
  }

  // シード用の1件はservice role client（RLSをバイパスする）で直接作成する。
  const loanOrderProcedureName = `クロス施設境界テスト用術式-${runId}`
  const { data: loanOrder, error: loanOrderError } = await supabase
    .from('loan_orders')
    .insert({
      facility_id: facilityA.id,
      procedure_name: loanOrderProcedureName,
      maker: 'クロス施設境界テスト用メーカー',
    })
    .select('id')
    .single()
  if (loanOrderError || !loanOrder) {
    throw new Error(`[E2E cross-facility auth] loan_ordersシード失敗: ${loanOrderError?.message}`)
  }

  // 明細に入れる製品を 1 件作る（products はマスタなので施設に属さない）
  const productJan = `e2e-jan-${runId}`
  const { data: product, error: productError } = await supabase
    .from('products')
    .insert({ jan: productJan, ref: `e2e-ref-${runId}` })
    .select('id')
    .single()
  if (productError || !product) {
    throw new Error(`[E2E cross-facility auth] products シード失敗: ${productError?.message}`)
  }

  // 代理店商品を 1 件作る（カテゴリ → 代理店商品の順。どちらもマスタなので施設に属さない）
  const { data: category, error: categoryError } = await supabase
    .from('categories')
    .insert({ name: `E2Eカテゴリ-${runId}` })
    .select('id')
    .single()
  if (categoryError || !category) {
    throw new Error(`[E2E cross-facility auth] categories シード失敗: ${categoryError?.message}`)
  }

  // 施設 A の返却を 1 件（明細つき）作る。品目ごとの取り消しの攻撃で叩く実物
  const { data: loanReturn, error: loanReturnError } = await supabase
    .from('loan_returns')
    .insert({ facility_id: facilityA.id, return_datetime: new Date().toISOString() })
    .select('id')
    .single()
  if (loanReturnError || !loanReturn) {
    throw new Error(`[E2E cross-facility auth] loan_returns シード失敗: ${loanReturnError?.message}`)
  }
  const { data: loanReturnItem, error: loanReturnItemError } = await supabase
    .from('loan_return_items')
    .insert({ loan_return_id: loanReturn.id, jan: productJan, quantity: 1 })
    .select('id')
    .single()
  if (loanReturnItemError || !loanReturnItem) {
    throw new Error(`[E2E cross-facility auth] loan_return_items シード失敗: ${loanReturnItemError?.message}`)
  }

  // 互換ペア（product_compatibilities）を 1 件作るには製品が 2 つ要る。
  // `ordered_pair` の CHECK（product_id_1 < product_id_2）があるので、UUID の辞書順に並べて入れる
  const { data: secondProduct, error: secondProductError } = await supabase
    .from('products')
    .insert({ jan: `e2e-jan2-${runId}`, ref: `e2e-ref2-${runId}` })
    .select('id')
    .single()
  if (secondProductError || !secondProduct) {
    throw new Error(`[E2E cross-facility auth] 2 件目の products シード失敗: ${secondProductError?.message}`)
  }
  const [pair1, pair2] = [product.id as string, secondProduct.id as string].sort()
  const { data: compatibility, error: compatibilityError } = await supabase
    .from('product_compatibilities')
    .insert({ category_id: category.id, product_id_1: pair1, product_id_2: pair2 })
    .select('id')
    .single()
  if (compatibilityError || !compatibility) {
    throw new Error(`[E2E cross-facility auth] product_compatibilities シード失敗: ${compatibilityError?.message}`)
  }

  const distributorProductName = `E2E代理店商品-${runId}`
  const { data: distributorProduct, error: dpError } = await supabase
    .from('distributor_products')
    .insert({
      product_id: product.id,
      category_id: category.id,
      maker: `E2Eメーカー-${runId}`,
      supplier: `E2E卸-${runId}`,
      name: distributorProductName,
      quantity: 1,
    })
    .select('id')
    .single()
  if (dpError || !distributorProduct) {
    throw new Error(`[E2E cross-facility auth] distributor_products シード失敗: ${dpError?.message}`)
  }

  // 施設 A の院内価格を 1 件作り、**値を変えて価格履歴を 1 行残す**。
  //
  // WHY(2026-09-09 追加): `/api/distributor-products/[id]/price-history` は
  //      施設スコープの履歴（entity_type = 'hospital_price'）を
  //      `is_facility_member(hp.facility_id) OR is_admin()` で絞る SECURITY DEFINER の RPC を叩く。
  //      ところが攻撃表（P-017）はこの route を **weak**（存在しない UUID を渡すので 404 止まり）
  //      として扱っており、**境界に一度も届いていなかった**。
  //      施設 A の履歴を実際に作れば、施設 B の利用者で叩いたときに
  //      「他施設の価格が本文に出ないか」を本当に測れる。
  //      価格は施設ごとの商談条件（脅威モデルの資産 A-02）で、漏れると実害が大きい。
  const facilityAPurchasePrice = 918273
  const { data: hospitalPrice, error: hpError } = await supabase
    .from('hospital_prices')
    .insert({
      distributor_product_id: distributorProduct.id,
      facility_id: facilityA.id,
      purchase_price: 111111,
      delivery_price: 222222,
    })
    .select('id')
    .single()
  if (hpError || !hospitalPrice) {
    throw new Error(`[E2E cross-facility auth] hospital_prices シード失敗: ${hpError?.message}`)
  }
  // WHY(作るだけでなく変える): 価格履歴は**値が変わったときだけ**トリガーが 1 行残す（I-041）。
  //      INSERT しただけでは履歴が生まれないので、ここで 1 回だけ改定する。
  const { error: priceUpdateError } = await supabase
    .from('hospital_prices')
    .update({ purchase_price: facilityAPurchasePrice })
    .eq('id', hospitalPrice.id)
  if (priceUpdateError) {
    throw new Error(`[E2E cross-facility auth] 価格改定シード失敗: ${priceUpdateError.message}`)
  }

  await signInAndSaveStorageState(supabase, emailA, CROSS_FACILITY_USER_A_AUTH_PATH)
  await signInAndSaveStorageState(supabase, emailB, CROSS_FACILITY_USER_B_AUTH_PATH)

  const fixtures: CrossFacilityFixtures = {
    facilityAId: facilityA.id as string,
    facilityBId: facilityB.id as string,
    loanOrderProcedureName,
    loanOrderId: loanOrder.id as string,
    productJan,
    facilityAName,
    distributorProductName,
    distributorProductId: distributorProduct.id as string,
    facilityAHospitalPriceId: hospitalPrice.id as string,
    facilityAPurchasePrice,
    productId: product.id as string,
    secondProductId: secondProduct.id as string,
    categoryId: category.id as string,
    compatibilityId: compatibility.id as string,
    loanReturnId: loanReturn.id as string,
    loanReturnItemId: loanReturnItem.id as string,
  }
  fs.writeFileSync(CROSS_FACILITY_FIXTURES_PATH, JSON.stringify(fixtures))
  console.log(`[E2E cross-facility auth] フィクスチャを書き出しました: ${CROSS_FACILITY_FIXTURES_PATH}`)
}

const isMainModule = process.argv[1]?.endsWith('generate-cross-facility-auth-state.ts')
if (isMainModule) {
  generateCrossFacilityAuthState().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
