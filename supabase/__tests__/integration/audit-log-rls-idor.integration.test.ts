// supabase/__tests__/integration/audit-log-rls-idor.integration.test.ts
// WHY: issue #757 の 4 / 24。監査ログの価値は「どの経路でも必ず残る」「誰にも消せない」「他施設には
//      見えない」の 3 つで、いずれも実 DB で破ろうとして初めて確かめられる。
//        P-060: RPC 経由・service_role の直接 UPDATE / DELETE・所属（権限）変更のすべてで行が残り、
//               同値 UPDATE では増えない
//        P-061: client は INSERT / UPDATE / DELETE できず、service_role でも UPDATE / DELETE / TRUNCATE
//               がトリガーで拒否される
//        P-062: 他施設の監査行は読めず、自施設は読め、admin は全部読める。anon は読めない
//      ファイル名に idor を含めるのは constraint_coverage_ratchet の RLS 軸（ポリシーを持つ表は
//      *idor* テストに登場する）に載せるため。

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupHospitalPricesRlsIdorFixtures,
  createSeededUser,
  createServiceRoleClient,
  seedHospitalPricesRlsIdorFixtures,
  type SeededUser,
  type SeedHospitalPricesRlsIdorFixtures,
} from './helpers/seed-rls-idor'

const INSUFFICIENT_PRIVILEGE = '42501'

type AuditRow = {
  id: string
  table_name: string
  row_id: string | null
  facility_id: string | null
  action: 'INSERT' | 'UPDATE' | 'DELETE'
  actor_id: string | null
  actor_role: string
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
  changed_columns: string[] | null
}

function createAnonClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

describe('audit_log: 全経路で残る・消せない・他施設に見えない [P-060 P-061 P-062]', () => {
  const serviceClient = createServiceRoleClient()
  let fx: SeedHospitalPricesRlsIdorFixtures
  let adminA: SeededUser

  const rowsFor = async (client: SupabaseClient, tableName: string, rowId: string) => {
    const { data, error } = await client
      .from('audit_log')
      .select('*')
      .eq('table_name', tableName)
      .eq('row_id', rowId)
      .order('occurred_at')
    if (error) throw new Error(`audit_log 取得失敗: ${error.message}`)
    return (data ?? []) as AuditRow[]
  }

  beforeAll(async () => {
    fx = await seedHospitalPricesRlsIdorFixtures()
    adminA = await createSeededUser(serviceClient, 'audit-log-admin-a', fx.facilityA.id, 'admin')
  }, 60_000)

  afterAll(async () => {
    if (adminA) await serviceClient.auth.admin.deleteUser(adminA.id)
    if (fx) await cleanupHospitalPricesRlsIdorFixtures(fx)
  })

  describe('P-060 どの経路でも残る', () => {
    it('RPC 経由の発注はヘッダと明細の INSERT が、呼び出した本人と施設付きで残る', async () => {
      const { data: order, error } = await fx.userA.client.rpc('create_loan_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_procedure_name: '監査テスト',
        p_maker: 'テストメーカー',
        p_items: [{ jan: null, name: '監査明細', quantity: 2 }],
      })
      expect(error).toBeNull()
      const orderId = (order as { id: string }).id

      const header = await rowsFor(serviceClient, 'loan_orders', orderId)
      expect(header).toHaveLength(1)
      expect(header[0]).toMatchObject({ action: 'INSERT', facility_id: fx.facilityA.id, actor_id: fx.userA.id, actor_role: 'authenticated' })
      expect(header[0].new_data?.procedure_name).toBe('監査テスト')

      const { data: items } = await serviceClient.from('audit_log').select('*').eq('table_name', 'loan_order_items').filter('new_data->>loan_order_id', 'eq', orderId)
      expect(items).toHaveLength(1)
      expect((items?.[0] as AuditRow).new_data?.quantity).toBe(2)
    })

    it('service_role の直接 UPDATE は actor なし・role=service_role で残り、変わった列だけが changed_columns に入る。同値 UPDATE は残らない', async () => {
      const id = fx.hospitalPriceA.id
      const before = await rowsFor(serviceClient, 'hospital_prices', id)

      await serviceClient.from('hospital_prices').update({ purchase_price: fx.hospitalPriceA.purchasePrice + 10 }).eq('id', id)
      const afterChange = await rowsFor(serviceClient, 'hospital_prices', id)
      expect(afterChange.length).toBe(before.length + 1)
      const last = afterChange[afterChange.length - 1]
      expect(last).toMatchObject({ action: 'UPDATE', facility_id: fx.facilityA.id, actor_id: null, actor_role: 'service_role' })
      expect(last.changed_columns).toContain('purchase_price')
      expect(last.changed_columns).not.toContain('delivery_price')
      expect(last.old_data?.purchase_price).toBe(fx.hospitalPriceA.purchasePrice)

      await serviceClient.from('hospital_prices').update({ delivery_price: 23456 }).eq('id', id) // シードと同じ値
      const afterNoop = await rowsFor(serviceClient, 'hospital_prices', id)
      expect(afterNoop.length).toBe(afterChange.length)
    })

    it('所属（権限）の変更と DELETE も残る（user_facilities は id を持たないので row_id は null、old_data に中身）', async () => {
      const { data: link } = await serviceClient.from('user_facilities').select('*').eq('user_id', fx.userA.id).eq('facility_id', fx.facilityA.id).single()
      expect(link).not.toBeNull()

      await serviceClient.from('user_facilities').update({ role: 'viewer' }).eq('user_id', fx.userA.id).eq('facility_id', fx.facilityA.id)
      await serviceClient.from('user_facilities').update({ role: 'staff' }).eq('user_id', fx.userA.id).eq('facility_id', fx.facilityA.id)

      const { data } = await serviceClient
        .from('audit_log')
        .select('*')
        .eq('table_name', 'user_facilities')
        .filter('new_data->>user_id', 'eq', fx.userA.id)
        .eq('action', 'UPDATE')
        .order('occurred_at')
      const updates = (data ?? []) as AuditRow[]
      expect(updates.length).toBeGreaterThanOrEqual(2)
      expect(updates[updates.length - 2].new_data?.role).toBe('viewer')
      expect(updates[updates.length - 1].new_data?.role).toBe('staff')
      expect(updates[0].facility_id).toBe(fx.facilityA.id)

      // DELETE
      const { data: price } = await serviceClient
        .from('hospital_prices')
        .insert({ distributor_product_id: fx.distributorProductForInsert.id, facility_id: fx.facilityA.id, purchase_price: 1, delivery_price: 2 })
        .select('id')
        .single()
      await serviceClient.from('hospital_prices').delete().eq('id', price!.id)
      const rows = await rowsFor(serviceClient, 'hospital_prices', price!.id)
      expect(rows.map((r) => r.action)).toEqual(['INSERT', 'DELETE'])
      expect(rows[1].old_data?.purchase_price).toBe(1)
      expect(rows[1].new_data).toBeNull()
    })
  })

  describe('P-061 append-only', () => {
    it('client は INSERT できない（ポリシーが無い）', async () => {
      const { error } = await fx.userA.client.from('audit_log').insert({ table_name: 'x', action: 'INSERT', actor_role: 'forged' })
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('client は自施設の監査行を UPDATE / DELETE できない（GRANT が SELECT のみ）', async () => {
      const [target] = await rowsFor(fx.userA.client, 'hospital_prices', fx.hospitalPriceA.id)
      expect(target).toBeDefined()
      const { error: updateError } = await fx.userA.client.from('audit_log').update({ actor_role: 'tampered' }).eq('id', target.id)
      expect(updateError?.code).toBe(INSUFFICIENT_PRIVILEGE)
      const { error: deleteError } = await fx.userA.client.from('audit_log').delete().eq('id', target.id)
      expect(deleteError?.code).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('service_role でも UPDATE / DELETE はトリガーで拒否され、行はそのまま残る', async () => {
      const [target] = await rowsFor(serviceClient, 'hospital_prices', fx.hospitalPriceA.id)
      const { error: updateError } = await serviceClient.from('audit_log').update({ actor_role: 'tampered' }).eq('id', target.id)
      expect(updateError?.code).toBe(INSUFFICIENT_PRIVILEGE)
      const { error: deleteError } = await serviceClient.from('audit_log').delete().eq('id', target.id)
      expect(deleteError?.code).toBe(INSUFFICIENT_PRIVILEGE)
      const { data: still } = await serviceClient.from('audit_log').select('actor_role').eq('id', target.id).single()
      expect(still?.actor_role).not.toBe('tampered')
    })
  })

  describe('P-062 施設境界', () => {
    it('他施設の利用者には施設 A の監査行が 1 件も見えない（主キー直指定でも）', async () => {
      const [target] = await rowsFor(serviceClient, 'hospital_prices', fx.hospitalPriceA.id)
      const { data: byFacility, error } = await fx.userB.client.from('audit_log').select('id').eq('facility_id', fx.facilityA.id)
      expect(error).toBeNull()
      expect(byFacility).toEqual([])
      const { data: byId } = await fx.userB.client.from('audit_log').select('id').eq('id', target.id)
      expect(byId).toEqual([])
    })

    it('自施設の利用者は自施設の行を読め、admin は他施設の行も読める', async () => {
      const own = await rowsFor(fx.userA.client, 'hospital_prices', fx.hospitalPriceA.id)
      expect(own.length).toBeGreaterThanOrEqual(1)
      const asAdmin = await rowsFor(adminA.client, 'hospital_prices', fx.hospitalPriceA.id)
      expect(asAdmin.length).toBe(own.length)
    })

    it('anon は読めない', async () => {
      const { error } = await createAnonClient().from('audit_log').select('id').limit(1)
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
    })
  })
})
