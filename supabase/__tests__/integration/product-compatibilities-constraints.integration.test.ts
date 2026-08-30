// supabase/__tests__/integration/product-compatibilities-constraints.integration.test.ts
// WHY: product_compatibilities は CHECK 2つ・複合UNIQUE・FK 3つを持ちながら、
//      実DBでの検証が一度も無かった（`findUncoveredConstraintMigrations` の検知で発覚。
//      docs/agents/known-failure-patterns.md「後付けFK列のカーディナリティ…（issue #675）」参照）。
//
//      DB制約は「破ろうとしたら拒否される」ことでしか検証できない。
//      既存の create_product_compatibilities.test.ts は静的SQL検証であり、
//      「その文字列がSQLに書いてある」ことしか確かめておらず、
//      **実装で書いた文字列を同じ文字列で照合する鏡**になっている（#675と同じ形）。
//
//      制約はRLSと違い service role でもバイパスされないため、ここでは
//      service role client で直接 insert して弾かれることを見る（認可の検証ではない）。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupProductCompatibilitiesFixtures,
  createServiceRoleClient,
  seedProductCompatibilitiesFixtures,
  type SeedProductCompatibilitiesFixtures,
} from './helpers/seed-rls-idor'

describe('product_compatibilities DB制約', () => {
  let fixtures: SeedProductCompatibilitiesFixtures
  const db = createServiceRoleClient()

  beforeAll(async () => {
    fixtures = await seedProductCompatibilitiesFixtures()
  }, 60_000)

  afterAll(async () => {
    if (fixtures) {
      await cleanupProductCompatibilitiesFixtures(fixtures)
    }
  })

  describe('あってはならない行が作れない', () => {
    it('同じ商品同士のペアは登録できない（no_self_compat）', async () => {
      const { data, error } = await db
        .from('product_compatibilities')
        .insert({
          category_id: fixtures.categoryA.id,
          product_id_1: fixtures.productSmall.id,
          product_id_2: fixtures.productSmall.id,
        })
        .select('id')

      expect(data).toBeNull()
      expect(error?.code).toBe('23514') // check_violation
      expect(error?.message).toContain('no_self_compat')
    })

    it('大小が逆順のペアは登録できない（ordered_pair。(a,b)と(b,a)の二重登録を防ぐ本体）', async () => {
      // WHY: この制約が効いていないと、同じ組み合わせが (a,b) と (b,a) の2行として
      //      登録でき、複合UNIQUEをすり抜ける。#675 の「1つの貸出に返却2件」と同じ形
      const { data, error } = await db
        .from('product_compatibilities')
        .insert({
          category_id: fixtures.categoryA.id,
          product_id_1: fixtures.productLarge.id,
          product_id_2: fixtures.productSmall.id,
        })
        .select('id')

      expect(data).toBeNull()
      expect(error?.code).toBe('23514')
      expect(error?.message).toContain('ordered_pair')
    })

    it('存在しないカテゴリを指定すると登録できない（FK）', async () => {
      const { data, error } = await db
        .from('product_compatibilities')
        .insert({
          category_id: '00000000-0000-0000-0000-000000000000',
          product_id_1: fixtures.productSmall.id,
          product_id_2: fixtures.productLarge.id,
        })
        .select('id')

      expect(data).toBeNull()
      expect(error?.code).toBe('23503') // foreign_key_violation
    })
  })

  describe('同じペアは同一カテゴリ内で1回だけ（複合UNIQUE）', () => {
    it('1回目は成功し、2回目は拒否される', async () => {
      const row = {
        category_id: fixtures.categoryA.id,
        product_id_1: fixtures.productSmall.id,
        product_id_2: fixtures.productLarge.id,
      }

      const first = await db.from('product_compatibilities').insert(row).select('id').single()
      expect(first.error).toBeNull()
      expect(first.data?.id).toBeTruthy()

      const second = await db.from('product_compatibilities').insert(row).select('id')
      expect(second.data).toBeNull()
      expect(second.error?.code).toBe('23505') // unique_violation

      // 結果としてDBに残る行は1件だけ
      const { data: rows } = await db
        .from('product_compatibilities')
        .select('id')
        .eq('category_id', fixtures.categoryA.id)
      expect(rows).toHaveLength(1)
    })

    it('カテゴリが違えば同じペアを登録できる（UNIQUEがcategory_id込みであることの対照）', async () => {
      // WHY: これが無いと、UNIQUEの範囲が (product_id_1, product_id_2) だけに
      //      狭まっていても上のテストは通ってしまう
      const { data, error } = await db
        .from('product_compatibilities')
        .insert({
          category_id: fixtures.categoryB.id,
          product_id_1: fixtures.productSmall.id,
          product_id_2: fixtures.productLarge.id,
        })
        .select('id')
        .single()

      expect(error).toBeNull()
      expect(data?.id).toBeTruthy()
    })
  })
})
