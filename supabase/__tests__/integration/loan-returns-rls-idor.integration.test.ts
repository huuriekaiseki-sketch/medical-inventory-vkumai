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

  // WHY(issue #675): loan_returns.loan_order_id には部分UNIQUEインデックス
  //  (loan_returns_loan_order_id_unique, migration 20260828000001)を追加した。
  //  同一loan_order_idへの2回目の返却登録が実際にDBレベルで拒否されることを、
  //  静的SQL検証（migrations/__tests__）ではなく本物のローカルSupabaseへの
  //  RPC呼び出しで確認する。
  describe('loan_order_id の重複登録防止 (issue #675)', () => {
    async function createLoanOrderForFacilityA(): Promise<string> {
      const { data, error } = await fixtures.userA.client.rpc('create_loan_order_atomic', {
        p_facility_id: fixtures.facilityA.id,
        p_procedure_name: '重複返却テスト術式',
        p_maker: '重複返却テストメーカー',
        p_items: [{ name: '重複返却テスト器材', quantity: 1 }],
      })
      if (error || !data) {
        throw new Error(`[loan-returns dedup test] loan_orders シード作成失敗: ${error?.message}`)
      }
      return (data as { id: string }).id
    }

    it('同一loan_order_idへ返却登録を2回連続で行うと、1回目は成功・2回目はエラーになる', async () => {
      const loanOrderId = await createLoanOrderForFacilityA()

      const first = await fixtures.userA.client.rpc('create_loan_return_atomic', {
        p_header: {
          facility_id: fixtures.facilityA.id,
          return_datetime: new Date().toISOString(),
          loan_order_id: loanOrderId,
        },
        p_items: [],
      })
      expect(first.error).toBeNull()
      expect(first.data).not.toBeNull()

      const second = await fixtures.userA.client.rpc('create_loan_return_atomic', {
        p_header: {
          facility_id: fixtures.facilityA.id,
          return_datetime: new Date().toISOString(),
          loan_order_id: loanOrderId,
        },
        p_items: [],
      })
      expect(second.data).toBeNull()
      expect(second.error).not.toBeNull()
      // WHY: 「何らかのエラー」ではなく、実際にUNIQUE制約違反(23505)であることまで確認する
      //      （コネクション失敗等の無関係なエラーでもテストが通ってしまうのを防ぐ）
      expect(second.error?.code).toBe('23505')
    })

    it('同一loan_order_idへ返却登録を2件同時送信すると、成功1件・失敗1件になり、loan_returns該当行は1件だけ残る', async () => {
      const loanOrderId = await createLoanOrderForFacilityA()

      const callRpc = () =>
        fixtures.userA.client.rpc('create_loan_return_atomic', {
          p_header: {
            facility_id: fixtures.facilityA.id,
            return_datetime: new Date().toISOString(),
            loan_order_id: loanOrderId,
          },
          p_items: [],
        })

      const results = await Promise.all([callRpc(), callRpc()])
      const succeeded = results.filter((r) => r.error === null)
      const failed = results.filter((r) => r.error !== null)
      expect(succeeded.length).toBe(1)
      expect(failed.length).toBe(1)
      expect(failed[0].error?.code).toBe('23505')

      const { data: rows, error } = await fixtures.userA.client
        .from('loan_returns')
        .select('id')
        .eq('loan_order_id', loanOrderId)
      expect(error).toBeNull()
      expect(rows?.length).toBe(1)
    })
  })
})
