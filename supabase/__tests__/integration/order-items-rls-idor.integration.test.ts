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
import { describeDenial, isPermissionDenied } from './helpers/pg-error'

// 約束カタログ（docs/agents/promise-catalog.md）: P-011 更新・削除・作成できない / P-013 明細は親経由で施設スコープ
describe('明細テーブル（親経由で施設スコープ）RLS/IDOR [P-011 P-013]', () => {
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
    /**
     * `authenticated` がまだ UPDATE の権限を持つか（2026-09-09）。
     *
     * WHY(表ごとに書く): 明細の UPDATE は「作ったら書き換えない」という判断で
     *      `case_order_items` / `consumable_order_items` から**権限ごと剥がした**（20260909030000）。
     *      剥がした表では、他施設のユーザーが弾かれる理由が**施設境界ではなく権限**に変わる。
     *      どちらでもテストは緑になるので、**どの層が止めているか**をここで書き分ける。
     *      書き分けないと「RLS が守っている」と読み続けてしまう（C-023 と同じ形）。
     */
    clientCanUpdate: boolean
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
      clientCanUpdate: false,
    },
    {
      table: 'consumable_order_items' as const,
      itemIdOf: (f: SeedOrderItemsRlsIdorFixtures) => f.items.consumableOrderItemId,
      newRowFor: (f: SeedOrderItemsRlsIdorFixtures) => ({
        consumable_order_id: f.parents.consumableOrderId,
        consumable_id: f.consumableId,
        quantity: 1,
      }),
      clientCanUpdate: false,
    },
    {
      table: 'loan_return_items' as const,
      itemIdOf: (f: SeedOrderItemsRlsIdorFixtures) => f.items.loanReturnItemId,
      newRowFor: (f: SeedOrderItemsRlsIdorFixtures) => ({
        loan_return_id: f.parents.loanReturnId,
        jan: f.jan,
        quantity: 1,
      }),
      // 品目ごとの取り消し（status）で使うので UPDATE は残っている
      clientCanUpdate: true,
    },
  ]

  describe.each(cases)('$table', ({ table, itemIdOf, newRowFor, clientCanUpdate }) => {
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

    it('他施設のユーザーは更新できない（止めている層まで言い当てる）', async () => {
      // WHY: 3テーブルとも quantity を持つ。
      //      **どの層が止めたか**まで見る。0 行なら施設境界（RLS）、42501 なら権限そのものが無い。
      //      片方だけを期待すると、剥がした・戻したどちらの変更も静かに通ってしまう
      const { data: updated, error } = await fixtures.userB.client
        .from(table)
        .update({ quantity: 999 })
        .eq('id', itemIdOf(fixtures))
        .select('id')

      if (clientCanUpdate) {
        expect(error, 'UPDATE の権限が剥がれている（宣言を直すこと）').toBeNull()
        expect(updated ?? []).toEqual([])
      } else {
        expect(isPermissionDenied(error), `UPDATE の権限が戻っている（20260909030000 で剥がしたはず）: ${describeDenial(error)}`).toBe(true)
      }

      const { data: after } = await fixtures.userA.client
        .from(table)
        .select('quantity')
        .eq('id', itemIdOf(fixtures))
        .single()
      expect(after?.quantity).toBe(1) // シード時の値
    })

    // WHY(2026-09-09): UPDATE を剥がした表では、**自施設の writer でも**書き換えられない。
    //      「他施設だから止まった」のではないことを対で測る（C-021 の型）
    it.runIf(!clientCanUpdate)('自施設のユーザーも更新できない（施設境界ではなく権限で止まる）', async () => {
      const { error } = await fixtures.userA.client
        .from(table)
        .update({ quantity: 999 })
        .eq('id', itemIdOf(fixtures))
        .select('id')
      expect(isPermissionDenied(error), `自施設の writer に UPDATE が通った: ${describeDenial(error)}`).toBe(true)
    })

    it('他施設のユーザーは削除できない（削除後も行が残る）', async () => {
      // WHY(2026-09-09): DELETE は 3 表とも権限ごと剥がした（20260909020000）。
      //      施設境界より手前で止まるので、他施設・自施設のどちらでも 42501 になる
      const { error: fromOther } = await fixtures.userB.client.from(table).delete().eq('id', itemIdOf(fixtures))
      expect(isPermissionDenied(fromOther), `DELETE の権限が戻っている: ${describeDenial(fromOther)}`).toBe(true)

      const { error: fromOwn } = await fixtures.userA.client.from(table).delete().eq('id', itemIdOf(fixtures))
      expect(isPermissionDenied(fromOwn), `自施設の writer に DELETE が通った: ${describeDenial(fromOwn)}`).toBe(true)

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
