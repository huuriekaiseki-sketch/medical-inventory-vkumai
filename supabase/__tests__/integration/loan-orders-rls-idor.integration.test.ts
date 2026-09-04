// supabase/__tests__/integration/loan-orders-rls-idor.integration.test.ts
// WHY: 施設A/施設Bという2つの本物のテスト施設と、それぞれに所属する本物の
//      認証済みユーザーを使い、「施設Bのユーザーが施設Aの短貸発注(loan_orders)に
//      アクセスできない」ことをPostgREST/RPC越しに直接確認する（issue #165）。
//      モック・静的SQL検証ではなく、本物のローカルSupabaseへの接続を伴う。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupRlsIdorFixtures,
  seedRlsIdorFixtures,
  type SeedRlsIdorFixtures,
} from './helpers/seed-rls-idor'

// 約束カタログ（docs/agents/promise-catalog.md）: P-010 他施設は読めない / P-012 RPC に他施設 id は forbidden / P-015 自施設は通る（対照）
describe('loan_orders RLS/IDOR (issue #165) [P-010 P-012 P-015]', () => {
  let fixtures: SeedRlsIdorFixtures

  beforeAll(async () => {
    fixtures = await seedRlsIdorFixtures()
  }, 60_000)

  afterAll(async () => {
    if (fixtures) {
      await cleanupRlsIdorFixtures(fixtures)
    }
  })

  it('ユーザーBは施設Aのloan_ordersを1件も取得できない', async () => {
    const { data, error } = await fixtures.userB.client
      .from('loan_orders')
      .select('*')
      .eq('facility_id', fixtures.facilityA.id)

    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('ユーザーBは施設Aに対してcreate_loan_order_atomicを呼ぶと拒否される', async () => {
    const { data, error } = await fixtures.userB.client.rpc('create_loan_order_atomic', {
      p_facility_id: fixtures.facilityA.id,
      p_procedure_name: 'IDORテスト術式',
      p_maker: 'IDORテストメーカー',
      p_items: [{ name: 'IDORテスト器材', quantity: 1 }],
    })

    expect(data).toBeNull()
    expect(error).not.toBeNull()
  })

  it('ユーザーAは自分の施設Aのloan_ordersを取得でき、シード済みの1件が含まれる', async () => {
    const { data, error } = await fixtures.userA.client
      .from('loan_orders')
      .select('*')
      .eq('facility_id', fixtures.facilityA.id)

    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
    expect(data!.some((row) => row.id === fixtures.loanOrderA.id)).toBe(true)
  })

  it('ユーザーAは自分の施設Aに対してcreate_loan_order_atomicを呼ぶと成功する', async () => {
    const { data, error } = await fixtures.userA.client.rpc('create_loan_order_atomic', {
      p_facility_id: fixtures.facilityA.id,
      p_procedure_name: '正常系テスト術式',
      p_maker: '正常系テストメーカー',
      // jan は loan_order_items.jan → products.jan への外部キーのため、
      // マスタ未登録の値を使うと無関係な理由(FK違反)で失敗する。ここでは検証対象外なので省略する。
      p_items: [{ name: '正常系テスト器材', quantity: 2 }],
    })

    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect((data as { facility_id?: string })?.facility_id).toBe(fixtures.facilityA.id)
  })
})
