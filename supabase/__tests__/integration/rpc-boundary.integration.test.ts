// supabase/__tests__/integration/rpc-boundary.integration.test.ts
// WHY: P-043（PR #760）の初回計測で「クライアントから呼べるのに境界テストで一度も呼んでいない RPC」が
//      9 本残った。いずれも client に公開が必要な関数（認可述語は RLS の USING 句から authenticated
//      ロールで呼ばれる、読み取り RPC はアプリが呼ぶ）なので REVOKE ではなく、
//      「他施設・非 admin・anon・aal1 で呼ぶと拒否されるか空になる」を実 DB で確かめる。
//      SECURITY DEFINER の述語は RLS を通らず関数内の auth.uid() だけが境界なので、
//      他人の施設 id を渡して false が返ることを見ないと「守られている」とは言えない。
//
//      対象（constraint-coverage-baseline.json の rpcWithoutBoundaryTest から外す）:
//        is_facility_member / is_facility_writer / is_admin / has_aal2 / get_admin_status /
//        get_distributor_product_price_history / get_news_feed / get_order_amount_report /
//        resolve_jan_unit_price

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupPriceHistoriesFixtures,
  createSeededUser,
  createServiceRoleClient,
  seedPriceHistoriesFixtures,
  type SeededUser,
  type SeedPriceHistoriesFixtures,
} from './helpers/seed-rls-idor'
import { enrollAndVerifyTotp, signInAtAal1, stepUpToAal2 } from './helpers/mfa-totp'

const PERMISSION_DENIED = '42501'
const MFA_USER_PASSWORD = 'rpc-boundary-mfa-0000'

function createAnonClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-045 認可述語・読み取り RPC は他施設・非 admin・anon・aal1 で拒否されるか空になる
describe('クライアントから呼べる RPC の境界（他施設・非 admin・anon・aal1） [P-045]', () => {
  const serviceClient = createServiceRoleClient()
  let fx: SeedPriceHistoriesFixtures
  let adminA: SeededUser
  let viewerA: SeededUser
  let jan: string

  beforeAll(async () => {
    fx = await seedPriceHistoriesFixtures()
    adminA = await createSeededUser(serviceClient, 'rpc-boundary-admin-a', fx.facilityA.id, 'admin')
    viewerA = await createSeededUser(serviceClient, 'rpc-boundary-viewer-a', fx.facilityA.id, 'viewer')
    const { data: product, error } = await serviceClient
      .from('products')
      .select('jan')
      .eq('id', fx.masters.productId)
      .single()
    if (error || !product) throw new Error(`products の jan 取得失敗: ${error?.message}`)
    jan = product.jan as string
  }, 90_000)

  afterAll(async () => {
    if (adminA) await serviceClient.auth.admin.deleteUser(adminA.id)
    if (viewerA) await serviceClient.auth.admin.deleteUser(viewerA.id)
    if (fx) await cleanupPriceHistoriesFixtures(fx)
  })

  describe('認可述語（SECURITY DEFINER。RLS の USING 句が呼ぶ）', () => {
    it('is_facility_member: 他施設の id では false、自施設では true、anon は false', async () => {
      const { data: other } = await fx.userB.client.rpc('is_facility_member', { p_facility_id: fx.facilityA.id })
      const { data: own } = await fx.userA.client.rpc('is_facility_member', { p_facility_id: fx.facilityA.id })
      const { data: anon } = await createAnonClient().rpc('is_facility_member', { p_facility_id: fx.facilityA.id })
      expect({ other, own, anon }).toEqual({ other: false, own: true, anon: false })
    })

    it('is_facility_writer: 他施設・viewer は false、同施設の staff は true', async () => {
      const { data: other } = await fx.userB.client.rpc('is_facility_writer', { p_facility_id: fx.facilityA.id })
      const { data: viewer } = await viewerA.client.rpc('is_facility_writer', { p_facility_id: fx.facilityA.id })
      const { data: staff } = await fx.userA.client.rpc('is_facility_writer', { p_facility_id: fx.facilityA.id })
      expect({ other, viewer, staff }).toEqual({ other: false, viewer: false, staff: true })
    })

    it('is_admin: staff・anon は false、admin は true', async () => {
      const { data: staff } = await fx.userA.client.rpc('is_admin')
      const { data: anon } = await createAnonClient().rpc('is_admin')
      const { data: admin } = await adminA.client.rpc('is_admin')
      expect({ staff, anon, admin }).toEqual({ staff: false, anon: false, admin: true })
    })

    it('has_aal2: MFA 未登録は true、登録済みの aal1 は false、aal2 へ昇格すると true', async () => {
      // MFA 登録は既存セッションの aal を変えるので、専用ユーザーで行う
      const email = `rpc-boundary-mfa-${randomUUID()}@example.test`
      const { data, error } = await serviceClient.auth.admin.createUser({
        email,
        password: MFA_USER_PASSWORD,
        email_confirm: true,
      })
      if (error || !data.user) throw new Error(`MFA ユーザー作成失敗: ${error?.message}`)
      try {
        const before = createAnonClient()
        await signInAtAal1(before, email, MFA_USER_PASSWORD)
        const { data: notEnrolled } = await before.rpc('has_aal2')

        const { factorId, secret } = await enrollAndVerifyTotp(before)

        const aal1 = createAnonClient()
        await signInAtAal1(aal1, email, MFA_USER_PASSWORD)
        const { data: enrolledAal1 } = await aal1.rpc('has_aal2')

        await stepUpToAal2(aal1, factorId, secret)
        const { data: enrolledAal2 } = await aal1.rpc('has_aal2')

        expect({ notEnrolled, enrolledAal1, enrolledAal2 }).toEqual({
          notEnrolled: true,
          enrolledAal1: false,
          enrolledAal2: true,
        })
      } finally {
        await serviceClient.auth.admin.deleteUser(data.user.id)
      }
    }, 30_000)
  })

  describe('読み取り RPC', () => {
    it('get_admin_status: 本人の admin フラグだけを返し、anon は呼べない（42501）', async () => {
      const { data: staff, error: staffError } = await fx.userA.client.rpc('get_admin_status')
      expect(staffError).toBeNull()
      expect(staff?.[0]).toEqual({ user_is_admin: false, db_has_admin: true })

      const { data: admin } = await adminA.client.rpc('get_admin_status')
      expect(admin?.[0]?.user_is_admin).toBe(true)

      const { error: anonError } = await createAnonClient().rpc('get_admin_status')
      expect(anonError?.code).toBe(PERMISSION_DENIED)
    })

    it('get_distributor_product_price_history: 他施設・anon には施設 A の価格履歴が混ざらず、自施設・admin には出る', async () => {
      const call = (client: SupabaseClient) =>
        client.rpc('get_distributor_product_price_history', { p_distributor_product_id: fx.distributorProduct.id })
      const ids = (rows: { id: string }[] | null) => (rows ?? []).map((r) => r.id)

      const { data: other, error: otherError } = await call(fx.userB.client)
      expect(otherError).toBeNull()
      expect(ids(other)).toContain(fx.masterHistory.id)
      expect(ids(other)).not.toContain(fx.facilityScopedHistory.id)

      // anon は GRANT されている（マスタの履歴は公開情報）。施設スコープの行は出ない
      const { data: anon, error: anonError } = await call(createAnonClient())
      expect(anonError).toBeNull()
      expect(ids(anon)).not.toContain(fx.facilityScopedHistory.id)

      const { data: own } = await call(fx.userA.client)
      expect(ids(own)).toContain(fx.facilityScopedHistory.id)
      const { data: admin } = await call(adminA.client)
      expect(ids(admin)).toContain(fx.facilityScopedHistory.id)
    })

    it('get_news_feed: SECURITY INVOKER なので他施設には施設 A の価格改定が出ず、anon はテーブル権限で拒否される', async () => {
      const args = { p_facility_id: fx.facilityA.id, p_limit: 100, p_offset: 0 }
      const ids = (rows: { id: string }[] | null) => (rows ?? []).map((r) => r.id)

      const { data: other, error: otherError } = await fx.userB.client.rpc('get_news_feed', args)
      expect(otherError).toBeNull()
      expect(ids(other)).not.toContain(fx.facilityScopedHistory.id)

      const { data: own, error: ownError } = await fx.userA.client.rpc('get_news_feed', args)
      expect(ownError).toBeNull()
      expect(ids(own)).toContain(fx.facilityScopedHistory.id)

      // 関数自体は PUBLIC 既定で呼べるが、中で読む price_histories 等は anon から REVOKE 済み
      const { data: anon, error: anonError } = await createAnonClient().rpc('get_news_feed', args)
      expect(anonError?.code, `anon が get_news_feed を読めた: ${JSON.stringify(anon)}`).toBe(PERMISSION_DENIED)
    })

    it('get_order_amount_report: 非 admin・anon は permission denied、admin は集計を返す', async () => {
      const args = { p_date_from: null, p_date_to: null }
      const { error: staffError } = await fx.userA.client.rpc('get_order_amount_report', args)
      expect(staffError?.message).toContain('permission denied')

      const { error: anonError } = await createAnonClient().rpc('get_order_amount_report', args)
      expect(anonError?.message).toContain('permission denied')

      const { data: admin, error: adminError } = await adminA.client.rpc('get_order_amount_report', args)
      expect(adminError).toBeNull()
      expect((admin ?? []).map((r: { facility_id: string }) => r.facility_id)).toContain(fx.facilityA.id)
    })

    // WHY(E-056): 2026-09-08 に発注の取り消しを作った（20260908070000）。
    //      集計はそれまで**状態を一切見ていなかった**ので、取り消した発注の金額が
    //      月次に載り続ける。RPC 本体で「取り消すと減る」ことを admin の目線で測る。
    it('get_order_amount_report: 取り消した発注の金額は集計に載らない', async () => {
      const args = { p_date_from: null, p_date_to: null }
      const caseAmount = async () => {
        const { data } = await adminA.client.rpc('get_order_amount_report', args)
        const row = (data ?? []).find((r: { facility_id: string }) => r.facility_id === fx.facilityA.id)
        return Number(row?.case_order_amount ?? 0)
      }

      const before = await caseAmount()

      const { data: order, error: createError } = await fx.userA.client.rpc('create_case_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_case_datetime: new Date().toISOString(),
        p_procedure_name: '集計取り消しテスト',
        p_patient_id: 'PT-REPORT-CANCEL',
        p_patient_initials: 'R.C.',
        p_gender: 'other',
        p_doctor_name: '集計取り消しテスト医師',
        p_items: [{ jan, lot: null, ubd: null, quantity: 3 }],
        p_client_request_id: randomUUID(),
      })
      expect(createError, JSON.stringify(createError)).toBeNull()

      const withOrder = await caseAmount()
      expect(withOrder, '発注しても集計が動かない（単価が付いていない）').toBeGreaterThan(before)

      const { error: cancelError } = await fx.userA.client
        .from('case_orders')
        .update({ status: 'cancelled' })
        .eq('id', (order as { id: string }).id)
      expect(cancelError, JSON.stringify(cancelError)).toBeNull()

      expect(await caseAmount(), '取り消したのに集計に残っている').toBe(before)
    })

    it('resolve_jan_unit_price: 他施設の facility_id では null、自施設では価格が返り、anon はテーブル権限で拒否される', async () => {
      const { data: other, error: otherError } = await fx.userB.client.rpc('resolve_jan_unit_price', {
        p_jan: jan,
        p_facility_id: fx.facilityA.id,
      })
      expect(otherError).toBeNull()
      expect(other).toBeNull()

      const { data: own } = await fx.userA.client.rpc('resolve_jan_unit_price', {
        p_jan: jan,
        p_facility_id: fx.facilityA.id,
      })
      expect(typeof own).toBe('number')

      const { error: anonError } = await createAnonClient().rpc('resolve_jan_unit_price', {
        p_jan: jan,
        p_facility_id: fx.facilityA.id,
      })
      expect(anonError?.code).toBe(PERMISSION_DENIED)
    })
  })
})
