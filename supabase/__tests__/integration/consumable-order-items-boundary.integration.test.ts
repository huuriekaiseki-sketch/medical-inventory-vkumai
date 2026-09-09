// supabase/__tests__/integration/consumable-order-items-boundary.integration.test.ts
// WHY(2026-09-09、実測で見つけた穴): `create_consumable_order_atomic` は
//      **明細が指す消耗品を一切見ていなかった**。実 DB で測ると 2 つが素通りしていた:
//
//        1. **他施設の消耗品**を指した発注が作れる
//        2. **使用停止（retired）した消耗品**を指した発注が作れる
//
//      1 は情報漏洩ではない（RLS が読み取りを止めるので、作った本人にも中身は null に見える）。
//      実害は**壊れた明細が作れる**ことと、外部キーが通るかどうかで
//      **他施設の消耗品 ID の存在を当てられる**こと。
//      2 は E-057 の穴。画面は使用停止のものを選択肢から外しているが、
//      **API を直接叩けば発注できた**（層の食い違い。E-055 / E-056 と同じ型）。
//
//      短貸返却の RPC（20260908040000）は同じ検証を持っていて、
//      **消耗品発注だけが持っていなかった**。20260909060000 で揃えた。
//
// ここで実 DB に固定するのは 6 つ:
//   1. 他施設の消耗品を指した発注は作れない
//   2. 使用停止した消耗品を指した発注は作れない
//   3. 自施設の生きた消耗品なら作れる（**誤検知しない**。止まる側だけ測ると常に拒否でも緑になる）
//   4. 明細が複数あって 1 つだけ悪いときも止まり、**発注ごと残らない**（部分成功しない）
//   5. 使用停止する**前**に作った発注は残る（過去の履歴を壊さない）
//   6. 文言で「何をすれば直せるか」が読める（アプリはこの文言で写す）

import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupHospitalPricesRlsIdorFixtures,
  createServiceRoleClient,
  seedHospitalPricesRlsIdorFixtures,
  type SeedHospitalPricesRlsIdorFixtures,
} from './helpers/seed-rls-idor'

const CHECK_VIOLATION = '23514'

// 不変条件カタログ: I-035 消耗品発注の明細は自施設の生きた消耗品だけを指す
describe('消耗品発注の明細は自施設の生きた消耗品だけ [I-035 P-013]', () => {
  const serviceClient = createServiceRoleClient()
  let fx: SeedHospitalPricesRlsIdorFixtures
  let jan: string
  /** 施設 A の生きた消耗品 */
  let activeA: string
  /** 施設 B の消耗品（他施設） */
  let otherFacility: string

  beforeAll(async () => {
    fx = await seedHospitalPricesRlsIdorFixtures()
    const { data } = await serviceClient.from('products').select('jan').eq('id', fx.masters.productId).single()
    jan = data!.jan as string
    activeA = await makeConsumable(fx.facilityA.id)
    otherFacility = await makeConsumable(fx.facilityB.id)
  }, 60_000)

  afterAll(async () => {
    if (fx) await cleanupHospitalPricesRlsIdorFixtures(fx)
  })

  /** 消耗品を 1 件作る（service_role。RLS を通さずに施設 B の分も作れる） */
  async function makeConsumable(facilityId: string, status?: string) {
    const row: Record<string, unknown> = {
      facility_id: facilityId,
      name: `境界テスト消耗品-${randomUUID().slice(0, 8)}`,
      jan,
      purpose: '境界テスト用',
    }
    if (status) row.status = status
    const { data, error } = await serviceClient.from('consumables').insert(row).select('id').single()
    expect(error, JSON.stringify(error)).toBeNull()
    return data!.id as string
  }

  /** 施設 A の利用者として消耗品発注を作る */
  const order = (...consumableIds: string[]) =>
    fx.userA.client.rpc('create_consumable_order_atomic', {
      p_facility_id: fx.facilityA.id,
      p_items: consumableIds.map((id) => ({ consumable_id: id, quantity: 1 })),
      p_client_request_id: randomUUID(),
    })

  const countOrders = async () => {
    const { count } = await serviceClient
      .from('consumable_orders')
      .select('id', { count: 'exact', head: true })
      .eq('facility_id', fx.facilityA.id)
    return count ?? 0
  }

  it('他施設の消耗品を指した発注は作れない', async () => {
    const res = await order(otherFacility)
    expect(res.error?.code, JSON.stringify(res.error)).toBe(CHECK_VIOLATION)
    expect(res.error?.message).toMatch(/is not orderable/)
  })

  it('使用停止した消耗品を指した発注は作れない', async () => {
    const retired = await makeConsumable(fx.facilityA.id, 'retired')
    const res = await order(retired)
    expect(res.error?.code, JSON.stringify(res.error)).toBe(CHECK_VIOLATION)
    expect(res.error?.message).toMatch(/is not orderable/)
  })

  it('自施設の生きた消耗品なら作れる（誤検知しない）', async () => {
    // WHY(C-021 の対): 止まる側だけを測ると「常に拒否」の実装でも緑になる
    const res = await order(activeA)
    expect(res.error, JSON.stringify(res.error)).toBeNull()
    const created = res.data as { id: string; items: unknown[] }
    expect(created.items).toHaveLength(1)
  })

  it('1 つだけ悪い明細があると発注ごと残らない（部分成功しない）', async () => {
    const before = await countOrders()
    const retired = await makeConsumable(fx.facilityA.id, 'retired')
    const res = await order(activeA, retired)
    expect(res.error?.code, JSON.stringify(res.error)).toBe(CHECK_VIOLATION)
    expect(await countOrders(), '悪い明細で止まったのにヘッダだけ残っている').toBe(before)
  })

  it('使用停止する前に作った発注は残る（過去の履歴を壊さない）', async () => {
    const target = await makeConsumable(fx.facilityA.id)
    const res = await order(target)
    expect(res.error, JSON.stringify(res.error)).toBeNull()
    const orderId = (res.data as { id: string }).id

    const { error: retireError } = await serviceClient
      .from('consumables')
      .update({ status: 'retired' })
      .eq('id', target)
    expect(retireError, JSON.stringify(retireError)).toBeNull()

    const { data: still } = await serviceClient
      .from('consumable_order_items')
      .select('id')
      .eq('consumable_order_id', orderId)
    expect(still, '使用停止で過去の明細が消えた').toHaveLength(1)

    // ただし新しくは作れない
    const again = await order(target)
    expect(again.error?.code).toBe(CHECK_VIOLATION)
  })

  it('存在しない消耗品 ID も同じ扱いで止まる', async () => {
    // WHY: 20260909060000 より前は外部キー（23503）で止まっていた。いまは検証が先に効くので
    //      23514 になる。**利用者への文言は同じ**（選べない消耗品）なので揃っているほうがよい
    const res = await order(randomUUID())
    expect(res.error?.code, JSON.stringify(res.error)).toBe(CHECK_VIOLATION)
  })
})
