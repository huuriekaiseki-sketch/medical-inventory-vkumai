// supabase/__tests__/integration/order-items-rls-idor.integration.test.ts
// WHY: case_order_items / consumable_order_items / loan_return_items は
//      **facility_id 列を持たない**。施設境界は親テーブル経由の
//      `EXISTS (... is_facility_member(o.facility_id) ...)` だけで守られている
//      （supabase/migrations/20260628010001_update_rls_admin.sql:71/85/113）。
//
//      親（case_orders / consumable_orders / loan_returns）にはIDOR統合テストがあるのに、
//      子の明細3つには一つも無かった（`findRlsTablesWithoutIdorTest` の検知で発覚。
//      `loan_order_items` だけテストがあり、同型3件の横展開漏れだった）。
//      **親が守られていることは、子が守られていることを意味しない**。
//      子は親をJOINせずPostgREST経由で直接叩けるため、独立した検証が要る。
//
//      なお怪しさ判定は当初これらを medium と誤って過小評価していた
//      （facility_id 列の有無しか見ていなかったため）。ポリシー本文の
//      is_facility_member も見るよう修正済み。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupOrderItemsRlsIdorFixtures,
  seedOrderItemsRlsIdorFixtures,
  type SeedOrderItemsRlsIdorFixtures,
} from './helpers/seed-rls-idor'

describe('明細テーブル（親経由で施設スコープ）RLS/IDOR', () => {
  let fixtures: SeedOrderItemsRlsIdorFixtures

  beforeAll(async () => {
    fixtures = await seedOrderItemsRlsIdorFixtures()
  }, 60_000)

  afterAll(async () => {
    if (fixtures) {
      await cleanupOrderItemsRlsIdorFixtures(fixtures)
    }
  })

  // WHY: 3テーブルを describe.each で回すため、テーブル名と行の型の対応が失われる。
  //      行は列構成が異なるので、共通の緩い型に寄せる（テストの意図は型検査ではない）
  type ItemCase = {
    table: 'case_order_items' | 'consumable_order_items' | 'loan_return_items'
    itemIdOf: (f: SeedOrderItemsRlsIdorFixtures) => string
    newRowFor: (f: SeedOrderItemsRlsIdorFixtures) => Record<string, unknown>
  }

  const cases: ItemCase[] = [
    {
      table: 'case_order_items' as const,
      itemIdOf: (f: SeedOrderItemsRlsIdorFixtures) => f.items.caseOrderItemId,
      newRowFor: (f: SeedOrderItemsRlsIdorFixtures) => ({
        case_order_id: f.parents.caseOrderId,
        jan: f.jan,
        quantity: 1,
      }),
    },
    {
      table: 'consumable_order_items' as const,
      itemIdOf: (f: SeedOrderItemsRlsIdorFixtures) => f.items.consumableOrderItemId,
      newRowFor: (f: SeedOrderItemsRlsIdorFixtures) => ({
        consumable_order_id: f.parents.consumableOrderId,
        consumable_id: f.consumableId,
        quantity: 1,
      }),
    },
    {
      table: 'loan_return_items' as const,
      itemIdOf: (f: SeedOrderItemsRlsIdorFixtures) => f.items.loanReturnItemId,
      newRowFor: (f: SeedOrderItemsRlsIdorFixtures) => ({
        loan_return_id: f.parents.loanReturnId,
        jan: f.jan,
        quantity: 1,
      }),
    },
  ]

  describe.each(cases)('$table', ({ table, itemIdOf, newRowFor }) => {
    it('他施設のユーザーは1件も取得できない', async () => {
      const { data, error } = await fixtures.userB.client.from(table).select('*')

      expect(error).toBeNull()
      expect(data).toEqual([])
    })

    it('他施設のユーザーは主キー直指定でも取得できない（IDを知っていても漏れない）', async () => {
      const { data, error } = await fixtures.userB.client
        .from(table)
        .select('*')
        .eq('id', itemIdOf(fixtures))

      expect(error).toBeNull()
      expect(data).toEqual([])
    })

    it('他施設のユーザーは更新できない（更新が1行も反映されない）', async () => {
      // WHY: 3テーブルとも quantity を持つ。ポリシーは FOR ALL なので
      //      SELECT/INSERT/DELETE だけ確かめて UPDATE を落とすとカバー範囲が不揃いになる
      const { data: updated } = await fixtures.userB.client
        .from(table)
        .update({ quantity: 999 })
        .eq('id', itemIdOf(fixtures))
        .select('id')

      expect(updated ?? []).toEqual([])

      const { data: after } = await fixtures.userA.client
        .from(table)
        .select('quantity')
        .eq('id', itemIdOf(fixtures))
        .single()
      expect(after?.quantity).toBe(1) // シード時の値
    })

    it('他施設のユーザーは削除できない（削除後も行が残る）', async () => {
      await fixtures.userB.client.from(table).delete().eq('id', itemIdOf(fixtures))

      const { data: after } = await fixtures.userA.client
        .from(table)
        .select('id')
        .eq('id', itemIdOf(fixtures))
      expect(after).toHaveLength(1)
    })

    it('他施設のユーザーは施設Aの親にぶら下げて作成できない（WITH CHECKで拒否）', async () => {
      const { data, error } = await fixtures.userB.client
        .from(table)
        .insert(newRowFor(fixtures))
        .select('id')

      expect(data).toBeNull()
      expect(error?.code).toBe('42501')
    })

    it('自施設のユーザーはシード済みの明細を取得できる（対照）', async () => {
      // WHY: 上の「見えない」が本当にRLSのせいかを保証する対照実験。
      //      これが無いと、テーブルが空なだけでも全部greenになる
      const { data, error } = await fixtures.userA.client
        .from(table)
        .select('id')
        .eq('id', itemIdOf(fixtures))

      expect(error).toBeNull()
      expect(data).toHaveLength(1)
    })
  })
})
