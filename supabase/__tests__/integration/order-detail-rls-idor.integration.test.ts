// supabase/__tests__/integration/order-detail-rls-idor.integration.test.ts
// WHY: issue #809（症例発注・短貸返却の詳細ページ）。GET /api/case-orders/[id]・GET /api/loan-returns/[id] が
//      乗る `getCaseOrder`・`getLoanReturn`（1 件を id だけで引く。施設 ID を引数に取らない「先引き」）の
//      施設境界を、本物のローカル Supabase で実測する。
//
// WHY(出荷する関数そのものを呼ぶ。2026-09-20 に人が書き直した): 最初の実装は、このファイルの中で
//      `client.from('case_orders').select('*').eq('id', …)` と**クエリを手で書き直して**測っていた。
//      それで測れるのは「親の表を素の select で引いたときの RLS」だけで、出荷する関数が投げる
//      `select('*, case_order_items(*)')`（明細の埋め込み）は 1 回も実 DB を通っていなかった。
//      issue #803 で統合ゲートが見つけた本物のバグ（`.ilike()` に引用符つきの値を渡すと常に 0 件）は
//      **クエリの組み立て**にあり、モックの単体テストでも、手で書き直したクエリでも見つからない。
//      テストが関数を通さないなら、関数のクエリを誰も実 DB で測っていないことになる。
//
// 測るもの:
//   - 対照: 自施設の一般メンバーは、明細（ロット・使用期限）ごと取得できる（P-015）
//   - **他施設の一般メンバー**は null（P-013）。admin は is_admin() の OR で RLS を全施設ぶん通るので、
//     admin のケースだけでは RLS の層を測れない
//   - admin は施設をまたいで取得できる（既存の権限と同じ範囲。URL の施設 ID との一致は画面が見る）
//   - 取り消し済みの明細を落とさない
//   - aal1 が repository まで届くと null になる（DB 層の事実。届かせないのは proxy の MFA ガード）

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  createServiceRoleClient,
  createFacility,
  createSeededUser,
  cleanupFacilitiesAndUsers,
  deleteWhereIn,
  type SeededUser,
} from './helpers/seed-rls-idor'
import { enrollAndVerifyTotp, signInAtAal1, stepUpToAal2 } from './helpers/mfa-totp'
import { getCaseOrder } from '../../../src/lib/case-orders/repository'
import { getLoanReturn } from '../../../src/lib/loan-returns/repository'

// WHY: has_aal2() は verified な TOTP factor を持たない利用者には TRUE を返すので、aal1 の境界は
//      「MFA 登録済みだが昇格していないセッション」でしか再現できない（lot-search-rls-idor と同じやり方）
const AAL_TEST_PASSWORD = 'order-detail-aal1-boundary-test-0000'

function createAnonClient(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

interface Fixtures {
  facilityA: { id: string; name: string }
  facilityB: { id: string; name: string }
  userA: SeededUser
  userB: SeededUser
  adminUser: SeededUser
  productId: string
  caseOrderId: string
  caseOrderItemId: string
  loanReturnId: string
  loanReturnItemId: string
  loanReturnItemCancelledId: string
  lot: string
  aal: { email: string; userId: string; factorId: string; secret: string }
}

async function seed(): Promise<Fixtures> {
  const serviceClient = createServiceRoleClient()
  const runId = randomUUID()
  const lot = `LOT-DETAIL-${runId}`

  const facilityA = await createFacility(serviceClient, `テスト施設A-${runId}`)
  const facilityB = await createFacility(serviceClient, `テスト施設B-${runId}`)
  const userA = await createSeededUser(serviceClient, 'rls-idor-order-detail-user-a', facilityA.id)
  const userB = await createSeededUser(serviceClient, 'rls-idor-order-detail-user-b', facilityB.id)
  const adminUser = await createSeededUser(serviceClient, 'rls-idor-order-detail-admin', facilityB.id, 'admin')

  const jan = `jan-order-detail-${runId}`
  const { data: product, error: productError } = await serviceClient
    .from('products')
    .insert({ jan, ref: `ref-order-detail-${runId}`, name: `シード用製品-${runId}` })
    .select('id')
    .single()
  if (productError || !product) {
    throw new Error(`[order-detail-rls-idor] products シード作成失敗: ${productError?.message}`)
  }

  const { data: caseOrder, error: caseOrderError } = await serviceClient
    .from('case_orders')
    .insert({
      facility_id: facilityA.id,
      case_datetime: new Date().toISOString(),
      procedure_name: 'シード用術式',
      patient_id: 'IDOR-TEST-PATIENT-DETAIL',
      patient_initials: 'IDORテスト患者',
      gender: 'other',
      doctor_name: 'IDORテスト医師',
    })
    .select('id')
    .single()
  if (caseOrderError || !caseOrder) {
    throw new Error(`[order-detail-rls-idor] case_orders シード作成失敗: ${caseOrderError?.message}`)
  }
  const { data: caseOrderItem, error: caseOrderItemError } = await serviceClient
    .from('case_order_items')
    .insert({ case_order_id: caseOrder.id, jan, lot, ubd: '2027-01', quantity: 2 })
    .select('id')
    .single()
  if (caseOrderItemError || !caseOrderItem) {
    throw new Error(`[order-detail-rls-idor] case_order_items シード作成失敗: ${caseOrderItemError?.message}`)
  }

  const { data: loanReturn, error: loanReturnError } = await serviceClient
    .from('loan_returns')
    .insert({ facility_id: facilityA.id, return_datetime: new Date().toISOString() })
    .select('id')
    .single()
  if (loanReturnError || !loanReturn) {
    throw new Error(`[order-detail-rls-idor] loan_returns シード作成失敗: ${loanReturnError?.message}`)
  }
  const { data: loanReturnItem, error: loanReturnItemError } = await serviceClient
    .from('loan_return_items')
    .insert({ loan_return_id: loanReturn.id, jan, lot, ubd: '2027-02', quantity: 1 })
    .select('id')
    .single()
  if (loanReturnItemError || !loanReturnItem) {
    throw new Error(`[order-detail-rls-idor] loan_return_items シード作成失敗: ${loanReturnItemError?.message}`)
  }
  // WHY: 作成時は必ず active。取り消しは active → cancelled の一方向の UPDATE（20260909000000）なので、実際の経路に合わせる
  const { data: cancelledItem, error: cancelledItemError } = await serviceClient
    .from('loan_return_items')
    .insert({ loan_return_id: loanReturn.id, jan, lot, quantity: 1 })
    .select('id')
    .single()
  if (cancelledItemError || !cancelledItem) {
    throw new Error(`[order-detail-rls-idor] 取り消し用 loan_return_items シード作成失敗: ${cancelledItemError?.message}`)
  }
  const { error: cancelError } = await serviceClient
    .from('loan_return_items')
    .update({ status: 'cancelled' })
    .eq('id', cancelledItem.id)
  if (cancelError) {
    throw new Error(`[order-detail-rls-idor] loan_return_items の取り消し失敗: ${cancelError.message}`)
  }

  const aalEmail = `rls-idor-order-detail-aal-${randomUUID()}@example.test`
  const { data: aalUserData, error: aalUserError } = await serviceClient.auth.admin.createUser({
    email: aalEmail,
    password: AAL_TEST_PASSWORD,
    email_confirm: true,
  })
  if (aalUserError || !aalUserData.user) {
    throw new Error(`[order-detail-rls-idor] aal境界用ユーザー作成失敗: ${aalUserError?.message}`)
  }
  const aalUserId = aalUserData.user.id
  const { error: aalLinkError } = await serviceClient
    .from('user_facilities')
    .insert({ user_id: aalUserId, facility_id: facilityA.id, role: 'staff' })
  if (aalLinkError) {
    throw new Error(`[order-detail-rls-idor] aal境界用ユーザーのuser_facilities作成失敗: ${aalLinkError.message}`)
  }
  const aalEnrollClient = createAnonClient()
  await signInAtAal1(aalEnrollClient, aalEmail, AAL_TEST_PASSWORD)
  const { factorId, secret } = await enrollAndVerifyTotp(aalEnrollClient)

  return {
    facilityA,
    facilityB,
    userA,
    userB,
    adminUser,
    productId: product.id as string,
    caseOrderId: caseOrder.id as string,
    caseOrderItemId: caseOrderItem.id as string,
    loanReturnId: loanReturn.id as string,
    loanReturnItemId: loanReturnItem.id as string,
    loanReturnItemCancelledId: cancelledItem.id as string,
    lot,
    aal: { email: aalEmail, userId: aalUserId, factorId, secret },
  }
}

async function cleanup(f: Fixtures): Promise<void> {
  const serviceClient = createServiceRoleClient()
  await cleanupFacilitiesAndUsers(f.userA, f.userB, f.facilityA, f.facilityB)
  await deleteWhereIn(serviceClient, 'products', 'id', [f.productId])
  await serviceClient.auth.admin.deleteUser(f.adminUser.id)
  await serviceClient.auth.admin.deleteUser(f.aal.userId)
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-013 明細/1 件取得は施設スコープ・P-015 自施設は通る（対照）
describe('getCaseOrder / getLoanReturn を id だけで引く（詳細ページの土台） [P-013 P-015]', () => {
  let fixtures: Fixtures

  beforeAll(async () => {
    fixtures = await seed()
  }, 60_000)

  afterAll(async () => {
    if (fixtures) {
      await cleanup(fixtures)
    }
  })

  describe('getCaseOrder', () => {
    it('自施設のメンバー（対照）は、登録した中身を明細（ロット・使用期限）ごと取得できる（P-015）', async () => {
      const order = await getCaseOrder(fixtures.userA.client, fixtures.caseOrderId)

      expect(order).toMatchObject({
        id: fixtures.caseOrderId,
        facilityId: fixtures.facilityA.id,
        patientId: 'IDOR-TEST-PATIENT-DETAIL',
        patientInitials: 'IDORテスト患者',
        doctorName: 'IDORテスト医師',
        procedureName: 'シード用術式',
      })
      expect(order?.items).toHaveLength(1)
      expect(order?.items[0]).toMatchObject({
        id: fixtures.caseOrderItemId,
        lot: fixtures.lot,
        ubd: '2027-01',
        quantity: 2,
      })
    })

    it('他施設の一般メンバーは、id を直指定しても null（層1: RLS。P-013）', async () => {
      const order = await getCaseOrder(fixtures.userB.client, fixtures.caseOrderId)

      expect(order).toBeNull()
    })

    it('admin は施設をまたいで取得できる（既存の権限と同じ範囲）', async () => {
      const order = await getCaseOrder(fixtures.adminUser.client, fixtures.caseOrderId)

      expect(order?.id).toBe(fixtures.caseOrderId)
      expect(order?.items).toHaveLength(1)
    })
  })

  describe('getLoanReturn', () => {
    it('自施設のメンバー（対照）は、明細（ロット・使用期限）ごと取得できる。取り消し済みの明細も落とさない（P-015）', async () => {
      const ret = await getLoanReturn(fixtures.userA.client, fixtures.loanReturnId)

      expect(ret).toMatchObject({ id: fixtures.loanReturnId, facilityId: fixtures.facilityA.id })
      expect(ret?.items).toHaveLength(2)
      const active = ret?.items.find((i) => i.id === fixtures.loanReturnItemId)
      const cancelled = ret?.items.find((i) => i.id === fixtures.loanReturnItemCancelledId)
      expect(active).toMatchObject({ lot: fixtures.lot, ubd: '2027-02', quantity: 1, status: 'active' })
      expect(cancelled).toMatchObject({ lot: fixtures.lot, status: 'cancelled' })
    })

    it('他施設の一般メンバーは、id を直指定しても null（層1: RLS。P-013）', async () => {
      const ret = await getLoanReturn(fixtures.userB.client, fixtures.loanReturnId)

      expect(ret).toBeNull()
    })

    it('admin は施設をまたいで取得できる（既存の権限と同じ範囲）', async () => {
      const ret = await getLoanReturn(fixtures.adminUser.client, fixtures.loanReturnId)

      expect(ret?.id).toBe(fixtures.loanReturnId)
    })
  })

  // WHY: **これは受け入れ条件そのものではなく、受け入れ条件が守るべき危険の DB 層での姿。**
  //      読み取りの RLS は has_aal2() を要求するので、aal1 のセッションが repository まで届くと、
  //      拒否ではなく null（＝route では 404「見つかりません」）になり、本当に無いのと区別がつかない。
  //      届かせないのは proxy の MFA ガードで、src/__tests__/proxy.test.ts の matcher のテスト
  //      （動的な区切りを含むパス）が対で固定している。proxy の matcher や MFA ガードを変える人は対で見ること
  describe('aal境界の DB 層での姿（aal1 が repository まで届くと null。届かせないのは proxy）', () => {
    it('MFA登録済みだがaal1のセッションでは、自施設の症例発注でも null になる', async () => {
      const client = createAnonClient()
      await signInAtAal1(client, fixtures.aal.email, AAL_TEST_PASSWORD)

      expect(await getCaseOrder(client, fixtures.caseOrderId)).toBeNull()
      expect(await getLoanReturn(client, fixtures.loanReturnId)).toBeNull()
    })

    it('対照: aal2まで昇格すると、同じユーザー・同じ id で取得できる', async () => {
      const client = createAnonClient()
      await signInAtAal1(client, fixtures.aal.email, AAL_TEST_PASSWORD)
      await stepUpToAal2(client, fixtures.aal.factorId, fixtures.aal.secret)

      expect((await getCaseOrder(client, fixtures.caseOrderId))?.id).toBe(fixtures.caseOrderId)
      expect((await getLoanReturn(client, fixtures.loanReturnId))?.id).toBe(fixtures.loanReturnId)
    })
  })
})
