// supabase/__tests__/integration/facility-delete-cascade.integration.test.ts
// WHY: issue #757 の 12（データの保持と削除）の DB 側、不変条件 I-052「施設を削除すると、その施設の
//      発注・返却・価格・所属が残らない」。FK の ON DELETE CASCADE は SQL を読めば書いてあるが、
//      「残らない」は実際に消して数えることでしか確かめられない（#675 の教訓）。
//      実測で唯一残っていたのが price_histories（hospital_prices への FK を持たない）で、
//      20260906000007 のトリガーで消えるようにした。監査ログは意図的に残す（削除の証跡）。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupPriceHistoriesFixtures,
  createServiceRoleClient,
  seedPriceHistoriesFixtures,
  type SeedPriceHistoriesFixtures,
} from './helpers/seed-rls-idor'

// 不変条件カタログ（docs/agents/invariant-catalog.md）: I-052 施設を削除すると施設スコープの行が残らない
describe('施設の削除で施設スコープの行が残らない [I-052]', () => {
  const serviceClient = createServiceRoleClient()
  let fx: SeedPriceHistoriesFixtures
  let jan: string
  let facilityId: string
  const ids: Record<string, string> = {}

  const countBy = async (table: string, column: string, value: string) => {
    // user_facilities は id 列を持たない（主キーは user_id, facility_id）ので '*' で数える
    const { count, error } = await serviceClient.from(table).select('*', { count: 'exact', head: true }).eq(column, value)
    if (error) throw new Error(`${table} の件数取得に失敗: ${error.message}`)
    return count ?? 0
  }

  beforeAll(async () => {
    fx = await seedPriceHistoriesFixtures()
    facilityId = fx.facilityA.id
    const { data } = await serviceClient.from('products').select('jan').eq('id', fx.masters.productId).single()
    jan = data!.jan as string

    // 施設 A に発注 3 種・返却・消耗品を本番と同じ経路（RPC）で作る
    const caseOrder = await fx.userA.client.rpc('create_case_order_atomic', {
      p_facility_id: facilityId,
      p_case_datetime: new Date().toISOString(),
      p_procedure_name: '削除テスト',
      p_patient_id: 'PT-DEL-1',
      p_patient_initials: 'D.L.',
      p_gender: 'other',
      p_doctor_name: 'テスト医師',
      p_items: [{ jan, lot: null, ubd: null, quantity: 1 }],
    })
    if (caseOrder.error) throw new Error(`case order: ${caseOrder.error.message}`)
    ids.caseOrder = (caseOrder.data as { id: string }).id

    const loanOrder = await fx.userA.client.rpc('create_loan_order_atomic', {
      p_facility_id: facilityId,
      p_procedure_name: '削除テスト',
      p_maker: 'テストメーカー',
      p_items: [{ jan, name: '削除テスト品', quantity: 1 }],
    })
    if (loanOrder.error) throw new Error(`loan order: ${loanOrder.error.message}`)
    ids.loanOrder = (loanOrder.data as { id: string }).id

    const loanReturn = await fx.userA.client.rpc('create_loan_return_atomic', {
      p_header: { facility_id: facilityId, return_datetime: new Date().toISOString(), loan_order_id: ids.loanOrder },
      p_items: [{ jan, lot: null, ubd: null, quantity: 1 }],
    })
    if (loanReturn.error) throw new Error(`loan return: ${loanReturn.error.message}`)
    ids.loanReturn = (loanReturn.data as { id: string }).id

    const { data: consumable, error: consumableError } = await serviceClient
      .from('consumables')
      .insert({ facility_id: facilityId, name: '削除テスト消耗品', purpose: 'test' })
      .select('id')
      .single()
    if (consumableError) throw new Error(`consumable: ${consumableError.message}`)
    ids.consumable = consumable!.id as string

    const consumableOrder = await fx.userA.client.rpc('create_consumable_order_atomic', {
      p_facility_id: facilityId,
      p_items: [{ consumable_id: ids.consumable, quantity: 2 }],
    })
    if (consumableOrder.error) throw new Error(`consumable order: ${consumableOrder.error.message}`)
    ids.consumableOrder = (consumableOrder.data as { id: string }).id
  }, 60_000)

  afterAll(async () => {
    if (fx) await cleanupPriceHistoriesFixtures(fx)
  })

  it('前提: 施設 A に所属・発注 3 種・明細・返却・消耗品・価格・価格履歴がある', async () => {
    expect(await countBy('user_facilities', 'facility_id', facilityId)).toBeGreaterThan(0)
    expect(await countBy('case_orders', 'facility_id', facilityId)).toBe(1)
    expect(await countBy('case_order_items', 'case_order_id', ids.caseOrder)).toBe(1)
    expect(await countBy('loan_orders', 'facility_id', facilityId)).toBe(1)
    expect(await countBy('loan_order_items', 'loan_order_id', ids.loanOrder)).toBe(1)
    expect(await countBy('loan_returns', 'facility_id', facilityId)).toBe(1)
    expect(await countBy('loan_return_items', 'loan_return_id', ids.loanReturn)).toBe(1)
    expect(await countBy('consumables', 'facility_id', facilityId)).toBe(1)
    expect(await countBy('consumable_orders', 'facility_id', facilityId)).toBe(1)
    expect(await countBy('consumable_order_items', 'consumable_order_id', ids.consumableOrder)).toBe(1)
    expect(await countBy('hospital_prices', 'facility_id', facilityId)).toBe(1)
    expect(await countBy('price_histories', 'entity_id', fx.hospitalPriceA.id)).toBeGreaterThan(0)
  })

  it('施設を削除すると、所属・発注・明細・返却・消耗品・価格・価格履歴がすべて 0 件になる', async () => {
    const { error } = await serviceClient.from('facilities').delete().eq('id', facilityId)
    expect(error).toBeNull()

    expect(await countBy('user_facilities', 'facility_id', facilityId)).toBe(0)
    expect(await countBy('case_orders', 'facility_id', facilityId)).toBe(0)
    expect(await countBy('case_order_items', 'case_order_id', ids.caseOrder)).toBe(0)
    expect(await countBy('loan_orders', 'facility_id', facilityId)).toBe(0)
    expect(await countBy('loan_order_items', 'loan_order_id', ids.loanOrder)).toBe(0)
    expect(await countBy('loan_returns', 'facility_id', facilityId)).toBe(0)
    expect(await countBy('loan_return_items', 'loan_return_id', ids.loanReturn)).toBe(0)
    expect(await countBy('consumables', 'facility_id', facilityId)).toBe(0)
    expect(await countBy('consumable_orders', 'facility_id', facilityId)).toBe(0)
    expect(await countBy('consumable_order_items', 'consumable_order_id', ids.consumableOrder)).toBe(0)
    expect(await countBy('hospital_prices', 'facility_id', facilityId)).toBe(0)
    // 20260906000007 のトリガーが無いとここだけ残る（FK が無い唯一の表）
    expect(await countBy('price_histories', 'entity_id', fx.hospitalPriceA.id)).toBe(0)
  })

  it('マスタ（製品・代理店商品・分類）とマスタの価格履歴は施設の削除で消えない', async () => {
    expect(await countBy('products', 'id', fx.masters.productId)).toBe(1)
    expect(await countBy('distributor_products', 'id', fx.distributorProduct.id)).toBe(1)
    expect(await countBy('price_histories', 'id', fx.masterHistory.id)).toBe(1)
  })

  it('監査ログは施設の削除後も残り、施設の DELETE と発注の DELETE が記録されている（証跡は消さない）', async () => {
    // facilities 自身の行は facility_id 列を持たないので監査行の facility_id は null。row_id（施設の id）で引く
    const { data: facilityRows, error: facilityError } = await serviceClient
      .from('audit_log')
      .select('table_name, action')
      .eq('table_name', 'facilities')
      .eq('row_id', facilityId)
    expect(facilityError).toBeNull()
    expect(facilityRows!.filter((r) => r.action === 'DELETE')).toHaveLength(1)

    // CASCADE で消えた発注は facility_id 付きで DELETE が残る
    const { data: rows, error } = await serviceClient
      .from('audit_log')
      .select('table_name, action')
      .eq('facility_id', facilityId)
    expect(error).toBeNull()
    const cascadedDeletes = rows!.filter((r) => r.action === 'DELETE' && r.table_name === 'case_orders')
    expect(cascadedDeletes).toHaveLength(1)
  })
})
