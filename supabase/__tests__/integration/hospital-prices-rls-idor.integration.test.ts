// supabase/__tests__/integration/hospital-prices-rls-idor.integration.test.ts
// WHY: hospital_prices は「施設ごとの購入価格・納入価格」であり、他の医療機関に
//      漏れてはいけない代表的なデータ。RLSポリシー facility_member_or_admin
//      （supabase/migrations/20260628010001_update_rls_admin.sql:35）は書かれていたが、
//      **他人（別施設のユーザー）のIDで実際に叩いて弾かれることを一度も確かめていなかった**
//      （`findRlsTablesWithoutIdorTest` の検知で発覚。
//        docs/agents/known-failure-patterns.md「後付けFK列のカーディナリティ…（issue #675）」
//        および「動いたからOKで…見逃す（issue #24再発防止）」参照）。
//
//      「ポリシーを書いた」＝「守られている」ではない。守られていることは、
//      破ろうとして弾かれることでしか確かめられない。
//      モック・静的SQL検証ではなく、本物のローカルSupabaseへの接続を伴う。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupHospitalPricesRlsIdorFixtures,
  seedHospitalPricesRlsIdorFixtures,
  type SeedHospitalPricesRlsIdorFixtures,
} from './helpers/seed-rls-idor'

// 約束カタログ（docs/agents/promise-catalog.md）: P-010 他施設は読めない / P-011 更新・削除・作成できない / P-015 自施設は通る（対照）
describe('hospital_prices RLS/IDOR [P-010 P-011 P-015]', () => {
  let fixtures: SeedHospitalPricesRlsIdorFixtures

  beforeAll(async () => {
    fixtures = await seedHospitalPricesRlsIdorFixtures()
  }, 60_000)

  afterAll(async () => {
    if (fixtures) {
      await cleanupHospitalPricesRlsIdorFixtures(fixtures)
    }
  })

  describe('他施設のユーザー（ユーザーB）から見えない・触れない', () => {
    it('施設Aの仕入価格を1件も取得できない', async () => {
      const { data, error } = await fixtures.userB.client
        .from('hospital_prices')
        .select('*')
        .eq('facility_id', fixtures.facilityA.id)

      expect(error).toBeNull()
      expect(data).toEqual([])
    })

    it('主キーを直接指定しても取得できない（IDを知っていても漏れない）', async () => {
      // WHY: facility_id で絞らず id 直指定 = 典型的なIDOR。行フィルタではなく
      //      RLSで止まっていることを確認する
      const { data, error } = await fixtures.userB.client
        .from('hospital_prices')
        .select('*')
        .eq('id', fixtures.hospitalPriceA.id)

      expect(error).toBeNull()
      expect(data).toEqual([])
    })

    it('施設Aの価格を書き換えられない（更新が1行も反映されない）', async () => {
      const { data: updated } = await fixtures.userB.client
        .from('hospital_prices')
        .update({ purchase_price: 1 })
        .eq('id', fixtures.hospitalPriceA.id)
        .select('id')

      expect(updated ?? []).toEqual([])

      // 実際に元の値が保たれていることを、権限のあるユーザーA側から確認する
      const { data: after } = await fixtures.userA.client
        .from('hospital_prices')
        .select('purchase_price')
        .eq('id', fixtures.hospitalPriceA.id)
        .single()

      expect(after?.purchase_price).toBe(fixtures.hospitalPriceA.purchasePrice)
    })

    it('施設Aの価格を削除できない（削除後も行が残る）', async () => {
      await fixtures.userB.client
        .from('hospital_prices')
        .delete()
        .eq('id', fixtures.hospitalPriceA.id)

      const { data: after } = await fixtures.userA.client
        .from('hospital_prices')
        .select('id')
        .eq('id', fixtures.hospitalPriceA.id)

      expect(after).toHaveLength(1)
    })

    it('施設Aを指定して新しい価格を作成できない（WITH CHECKで拒否される）', async () => {
      // WHY: シード済みと同じ distributor_product を使うと unique(distributor_product_id,
      //      facility_id) 違反で**誰が呼んでも失敗**し、RLSを検証できない（実際に踏んだ）。
      //      未使用の商品を使い、さらにエラーコードが 42501（権限不足）であることまで
      //      確認して、拒否の理由をRLSに限定する
      const { data, error } = await fixtures.userB.client
        .from('hospital_prices')
        .insert({
          distributor_product_id: fixtures.distributorProductForInsert.id,
          facility_id: fixtures.facilityA.id,
          purchase_price: 99,
          delivery_price: 99,
        })
        .select('id')

      expect(data).toBeNull()
      expect(error?.code).toBe('42501')
    })
  })

  describe('自施設のユーザー（ユーザーA）は通常どおり扱える', () => {
    it('自施設の価格を取得でき、シード済みの値が読める', async () => {
      // WHY: 件数で断定すると、同じdescribe内の作成テストが先に走った場合に壊れる
      //      （テスト順序に依存させない）。シード済みの行が含まれることを見る
      const { data, error } = await fixtures.userA.client
        .from('hospital_prices')
        .select('id, purchase_price')
        .eq('facility_id', fixtures.facilityA.id)

      expect(error).toBeNull()
      const seeded = data?.find((row) => row.id === fixtures.hospitalPriceA.id)
      expect(seeded?.purchase_price).toBe(fixtures.hospitalPriceA.purchasePrice)
    })

    it('自施設を指定した新規作成は成功する（拒否がRLS由来であることの対照）', async () => {
      // WHY: 上の「ユーザーBは作成できない」が本当にRLSのせいかを保証する対照実験。
      //      これが無いと、payloadの不備で常に失敗しているだけでも気づけない
      const { data, error } = await fixtures.userA.client
        .from('hospital_prices')
        .insert({
          distributor_product_id: fixtures.distributorProductForInsert.id,
          facility_id: fixtures.facilityA.id,
          purchase_price: 111,
          delivery_price: 222,
        })
        .select('id')
        .single()

      expect(error).toBeNull()
      expect(data?.id).toBeTruthy()
    })
  })
})
