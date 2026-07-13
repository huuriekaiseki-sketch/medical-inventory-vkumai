// supabase/__tests__/integration/consumable-orders-rls-idor.integration.test.ts
// WHY: loan-orders-rls-idor.integration.test.ts（issue #165）と同じ手法で、
//      consumable_orders でも「施設Bのユーザーが施設Aの消耗品発注にアクセスできない」ことを
//      本物のローカルSupabaseへの接続を伴って確認する（issue #315: 他テーブルへの横展開）。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupConsumableOrdersRlsIdorFixtures,
  seedConsumableOrdersRlsIdorFixtures,
  type SeedConsumableOrdersRlsIdorFixtures,
} from './helpers/seed-rls-idor'

describe('consumable_orders RLS/IDOR (issue #315)', () => {
  let fixtures: SeedConsumableOrdersRlsIdorFixtures

  beforeAll(async () => {
    fixtures = await seedConsumableOrdersRlsIdorFixtures()
  }, 60_000)

  afterAll(async () => {
    if (fixtures) {
      await cleanupConsumableOrdersRlsIdorFixtures(fixtures)
    }
  })

  it('ユーザーBは施設Aのconsumable_ordersを1件も取得できない', async () => {
    const { data, error } = await fixtures.userB.client
      .from('consumable_orders')
      .select('*')
      .eq('facility_id', fixtures.facilityA.id)

    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('ユーザーBは施設Aに対してcreate_consumable_order_atomicを呼ぶと拒否される', async () => {
    const { data, error } = await fixtures.userB.client.rpc('create_consumable_order_atomic', {
      p_facility_id: fixtures.facilityA.id,
      p_items: [],
    })

    expect(data).toBeNull()
    expect(error).not.toBeNull()
  })

  it('ユーザーAは自分の施設Aのconsumable_ordersを取得でき、シード済みの1件が含まれる', async () => {
    const { data, error } = await fixtures.userA.client
      .from('consumable_orders')
      .select('*')
      .eq('facility_id', fixtures.facilityA.id)

    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
    expect(data!.some((row) => row.id === fixtures.consumableOrderA.id)).toBe(true)
  })

  it('ユーザーAは自分の施設Aに対してcreate_consumable_order_atomicを呼ぶと成功する', async () => {
    const { data, error } = await fixtures.userA.client.rpc('create_consumable_order_atomic', {
      p_facility_id: fixtures.facilityA.id,
      p_items: [],
    })

    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect((data as { facility_id?: string })?.facility_id).toBe(fixtures.facilityA.id)
  })
})
