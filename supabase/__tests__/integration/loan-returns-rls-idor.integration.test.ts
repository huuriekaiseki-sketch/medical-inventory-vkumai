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
} from './helpers/seed-rls-idor'

describe('loan_returns RLS/IDOR', () => {
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
})
