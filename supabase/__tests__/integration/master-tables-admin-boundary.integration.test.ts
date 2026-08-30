// supabase/__tests__/integration/master-tables-admin-boundary.integration.test.ts
// WHY: categories / distributor_products / products / product_compatibilities / facilities は
//      SELECT が `USING (true)`（意図的にテナント非分離）で、**書き込みだけが is_admin() に
//      限定される**。施設境界の約束が無いためRLS/IDOR軸からは除外したが、
//      「除外して終わり」にすると面倒な指摘を逃がしただけになる。
//      これらが実際に守っているのは **admin境界** であり、そこを一度も試していなかった
//      （`findAdminOnlyTablesWithoutTest` で5/5テーブル未検証と判明）。
//
//      is_admin() は user_facilities.role='admin' を見るだけなので
//      （20260628010000_add_role_to_user_facilities.sql:30）、
//      施設のメンバーではあるが admin ではない staff ユーザーとの差分で検証する。
//      「施設外だから書けない」ではなく「adminでないから書けない」ことを見る点が
//      IDORテストとの違い。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupAdminBoundaryFixtures,
  seedAdminBoundaryFixtures,
  type SeedAdminBoundaryFixtures,
} from './helpers/seed-rls-idor'

describe('マスタテーブルのadmin境界', () => {
  let fixtures: SeedAdminBoundaryFixtures

  beforeAll(async () => {
    fixtures = await seedAdminBoundaryFixtures()
  }, 60_000)

  afterAll(async () => {
    if (fixtures) {
      await cleanupAdminBoundaryFixtures(fixtures)
    }
  })

  describe('staff（施設メンバーだがadminではない）は書き込めない', () => {
    it('categories を作成できない', async () => {
      const { data, error } = await fixtures.staffUser.client
        .from('categories')
        .insert({ name: `staffが作ったカテゴリ-${fixtures.runId}` })
        .select('id')

      expect(data).toBeNull()
      expect(error?.code).toBe('42501')
    })

    it('categories を更新できない（更新が1行も反映されない）', async () => {
      const { data: updated } = await fixtures.staffUser.client
        .from('categories')
        .update({ description: 'staffによる改ざん' })
        .eq('id', fixtures.existing.categoryId)
        .select('id')

      expect(updated ?? []).toEqual([])
    })

    it('products を作成できない', async () => {
      const { data, error } = await fixtures.staffUser.client
        .from('products')
        .insert({
          jan: `jan-staff-${fixtures.runId}`,
          ref: `ref-staff-${fixtures.runId}`,
          name: 'staffが作った製品',
        })
        .select('id')

      expect(data).toBeNull()
      expect(error?.code).toBe('42501')
    })

    it('distributor_products を更新できない（価格の改ざんが通らない）', async () => {
      // WHY: reimbursement_price はトリガーで price_histories に履歴が残る値。
      //      ここが通ると、権限のないユーザーが償還価格を書き換えられる
      const { data: updated } = await fixtures.staffUser.client
        .from('distributor_products')
        .update({ reimbursement_price: 1 })
        .eq('id', fixtures.existing.distributorProductId)
        .select('id')

      expect(updated ?? []).toEqual([])
    })

    it('product_compatibilities を作成できない', async () => {
      // WHY: 同じ製品IDを2つ渡すと no_self_compat CHECK で誰が呼んでも失敗し、
      //      「adminでないから拒否された」ことを検証できない（実際にこの罠を踏んだ）。
      //      正しい順序の別製品ペアを使い、エラーコードが 42501（権限不足）であることまで見る
      const { data, error } = await fixtures.staffUser.client
        .from('product_compatibilities')
        .insert({
          category_id: fixtures.existing.categoryId,
          product_id_1: fixtures.compatPair.small,
          product_id_2: fixtures.compatPair.large,
        })
        .select('id')

      expect(data).toBeNull()
      expect(error?.code).toBe('42501')
    })

    it('facilities を作成できない（admin_insert ポリシー）', async () => {
      const { data, error } = await fixtures.staffUser.client
        .from('facilities')
        .insert({ name: `staffが作った施設-${fixtures.runId}` })
        .select('id')

      expect(data).toBeNull()
      expect(error?.code).toBe('42501')
    })

    it('マスタの参照はできる（テナント非分離。設計どおり）', async () => {
      // WHY: これが取れないなら「adminでないから書けない」ではなく
      //      「そもそも何もできない」だけで、上の6件は何も証明していない
      const { data, error } = await fixtures.staffUser.client
        .from('categories')
        .select('id')
        .eq('id', fixtures.existing.categoryId)

      expect(error).toBeNull()
      expect(data).toHaveLength(1)
    })
  })

  describe('adminは書き込める（対照）', () => {
    it('categories を作成できる', async () => {
      const { data, error } = await fixtures.adminUser.client
        .from('categories')
        .insert({ name: `adminが作ったカテゴリ-${fixtures.runId}` })
        .select('id')
        .single()

      expect(error).toBeNull()
      expect(data?.id).toBeTruthy()
    })

    it('distributor_products を更新できる', async () => {
      const { data, error } = await fixtures.adminUser.client
        .from('distributor_products')
        .update({ reimbursement_price: 777 })
        .eq('id', fixtures.existing.distributorProductId)
        .select('id')
        .single()

      expect(error).toBeNull()
      expect(data?.id).toBe(fixtures.existing.distributorProductId)
    })
  })
})
