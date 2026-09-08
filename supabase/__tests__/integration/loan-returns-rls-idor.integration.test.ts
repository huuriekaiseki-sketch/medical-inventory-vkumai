// supabase/__tests__/integration/loan-returns-rls-idor.integration.test.ts
// WHY: 施設A/施設Bという2つの本物のテスト施設と、それぞれに所属する本物の
//      認証済みユーザーを使い、「施設Bのユーザーが施設Aの返却(loan_returns)に
//      アクセスできない」ことをPostgREST/RPC越しに直接確認する。
//      loan_returnsはloan_ordersと同じfacility_member_or_admin RLSポリシー
//      （supabase/migrations/20260628010001_update_rls_admin.sql）で保護されて
//      おり、src/lib/dashboard/loan-outstanding.tsのgetLoanOutstandingCountが
//      このテーブルをクエリしているが、case_orders/consumable_orders/loan_orders
//      にはあるテーブル単体のRLS/IDOR統合テストがloan_returnsだけ欠落していた
//      （docs/agents/known-failure-patterns.md「RLS/テナント分離層」チェックリスト）。
//      モック・静的SQL検証ではなく、本物のローカルSupabaseへの接続を伴う。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLoanReturnsRlsIdorFixtures,
  seedLoanReturnsRlsIdorFixtures,
  type SeedLoanReturnsRlsIdorFixtures,
  createServiceRoleClient,
} from './helpers/seed-rls-idor'

// 約束カタログ（docs/agents/promise-catalog.md）: P-010 他施設は読めない / P-012 RPC に他施設 id は forbidden / P-015 自施設は通る（対照）/ P-050 返却は 1 件まで
// 不変条件カタログ（docs/agents/invariant-catalog.md）: I-030 短貸発注 1 件に返却は 1 件まで
describe('loan_returns RLS/IDOR [P-010 P-012 P-015 I-030]', () => {
  let fixtures: SeedLoanReturnsRlsIdorFixtures

  beforeAll(async () => {
    fixtures = await seedLoanReturnsRlsIdorFixtures()
  }, 60_000)

  afterAll(async () => {
    if (fixtures) {
      await cleanupLoanReturnsRlsIdorFixtures(fixtures)
    }
  })

  it('ユーザーBは施設Aのloan_returnsを1件も取得できない', async () => {
    const { data, error } = await fixtures.userB.client
      .from('loan_returns')
      .select('*')
      .eq('facility_id', fixtures.facilityA.id)

    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('ユーザーBは施設Aに対してcreate_loan_return_atomicを呼ぶと拒否される', async () => {
    const { data, error } = await fixtures.userB.client.rpc('create_loan_return_atomic', {
      p_header: {
        facility_id: fixtures.facilityA.id,
        return_datetime: new Date().toISOString(),
      },
      p_items: [],
    })

    expect(data).toBeNull()
    expect(error).not.toBeNull()
  })

  it('ユーザーAは自分の施設Aのloan_returnsを取得でき、シード済みの1件が含まれる', async () => {
    const { data, error } = await fixtures.userA.client
      .from('loan_returns')
      .select('*')
      .eq('facility_id', fixtures.facilityA.id)

    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
    expect(data!.some((row) => row.id === fixtures.loanReturnA.id)).toBe(true)
  })

  it('ユーザーAは自分の施設Aに対してcreate_loan_return_atomicを呼ぶと成功する', async () => {
    const { data, error } = await fixtures.userA.client.rpc('create_loan_return_atomic', {
      p_header: {
        facility_id: fixtures.facilityA.id,
        return_datetime: new Date().toISOString(),
      },
      p_items: [],
    })

    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect((data as { facility_id?: string })?.facility_id).toBe(fixtures.facilityA.id)
  })

  // WHY(2026-09-08 に約束が変わった): 20260828000001 の部分 UNIQUE は
  //  「1 発注 : 1 返却」を強制していたが、**分割して返す運用が実在する**ことを確認したので
  //  20260908030000 で外した。守るものは「2 回目を拒否する」から
  //  **「明細ごとに、借りた数を超えて返せない」**に変わった（P-050）。
  //  静的 SQL 検証ではなく本物のローカル Supabase への RPC 呼び出しで確認する。
  describe('借りた数を超えて返せない（分割返却）[P-050]', () => {
    // WHY: `loan_return_items.jan` は `products.jan` への外部キー（E-050）。
    //      作り話の JAN では 23503 で弾かれるので、この describe 用に 1 件作っておく
    let jan: string

    beforeAll(async () => {
      const serviceClient = createServiceRoleClient()
      const suffix = Math.random().toString(36).slice(2, 10)
      jan = `partial-return-jan-${suffix}`
      const { error } = await serviceClient
        .from('products')
        .insert({ jan, ref: `partial-return-ref-${suffix}` })
      if (error) throw new Error(`[loan-returns partial test] products シード失敗: ${error.message}`)
    })

    async function createLoanOrderForFacilityA(quantity: number): Promise<{ orderId: string; itemId: string }> {
      const { data, error } = await fixtures.userA.client.rpc('create_loan_order_atomic', {
        p_facility_id: fixtures.facilityA.id,
        p_procedure_name: '分割返却テスト術式',
        p_maker: '分割返却テストメーカー',
        p_items: [{ name: '分割返却テスト器材', quantity }],
      })
      if (error || !data) {
        throw new Error(`[loan-returns partial test] loan_orders シード作成失敗: ${error?.message}`)
      }
      const order = data as { id: string; items: { id: string }[] }
      return { orderId: order.id, itemId: order.items[0].id }
    }

    const makeReturn = (orderId: string, itemId: string, quantity: number) =>
      fixtures.userA.client.rpc('create_loan_return_atomic', {
        p_header: {
          facility_id: fixtures.facilityA.id,
          return_datetime: new Date().toISOString(),
          loan_order_id: orderId,
        },
        p_items: [{ jan, quantity, loan_order_item_id: itemId }],
      })

    it('同じ短貸発注へ 2 回目の返却ができる（分割して返せる）', async () => {
      const { orderId, itemId } = await createLoanOrderForFacilityA(2)

      const first = await makeReturn(orderId, itemId, 1)
      expect(first.error, JSON.stringify(first.error)).toBeNull()

      // WHY: 部分 UNIQUE があったころは、ここが 23505 で弾かれていた
      const second = await makeReturn(orderId, itemId, 1)
      expect(second.error, JSON.stringify(second.error)).toBeNull()

      const { data: rows } = await fixtures.userA.client
        .from('loan_returns')
        .select('id')
        .eq('loan_order_id', orderId)
      expect(rows?.length, '同じ発注に 2 件の返却が残る').toBe(2)
    })

    it('合計が借りた数を超える返却は拒否される', async () => {
      const { orderId, itemId } = await createLoanOrderForFacilityA(2)
      expect((await makeReturn(orderId, itemId, 2)).error).toBeNull()

      const over = await makeReturn(orderId, itemId, 1)
      expect(over.error?.code, JSON.stringify(over.error)).toBe('23514')
    })

    it('全部返す返却を 2 件同時に送ると、成功 1 件・失敗 1 件になる', async () => {
      // WHY: 2 件が同時に「まだ余っている」と読んで両方通ると、借りた数の 2 倍が返る。
      //      トリガーが発注明細を FOR UPDATE で掴んで順番を付けていることを実測する
      const { orderId, itemId } = await createLoanOrderForFacilityA(1)

      const results = await Promise.all([
        makeReturn(orderId, itemId, 1),
        makeReturn(orderId, itemId, 1),
      ])
      const succeeded = results.filter((r) => r.error === null)
      const failed = results.filter((r) => r.error !== null)
      expect(succeeded.length, JSON.stringify(results.map((r) => r.error))).toBe(1)
      expect(failed.length).toBe(1)
      expect(failed[0].error?.code).toBe('23514')

      const { data: items } = await fixtures.userA.client
        .from('loan_return_items')
        .select('quantity')
        .eq('loan_order_item_id', itemId)
      const total = (items ?? []).reduce((n, i) => n + (i.quantity as number), 0)
      expect(total, '借りた数を超えて記録が残った').toBe(1)
    })
  })
})
