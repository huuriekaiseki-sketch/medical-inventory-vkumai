// supabase/__tests__/integration/price-histories-rls-idor.integration.test.ts
// WHY: price_histories は「施設ごとの仕入価格の変更履歴」であり、現在値
//      （hospital_prices）と同じ機微度を持つ。にもかかわらず RLS/IDOR統合テストも
//      CHECK制約の実DB検証も無かった（`findRlsTablesWithoutIdorTest` と
//      `findUncoveredConstraintMigrations` の両方に出ていた唯一のテーブル）。
//
//      ポリシーはポリモーフィックで、entity_type によって施設スコープの有無が変わる
//      （20260628010001_update_rls_admin.sql:130）:
//        - 'hospital_price'      → 親 hospital_prices の施設をチェックする
//        - 'distributor_product' → true（マスタなので全員可。設計どおり）
//      「全部見えない」でも「全部見える」でもない**分岐**なので、両方を確かめる。
//
//      さらに、この表には古い許可ポリシー price_histories_select（USING(true)）が
//      20260622 に作られ 20260626001000_enable_rls.sql:51 で DROP されている。
//      PostgreSQLの permissive ポリシーは OR で合成されるため、この DROP が
//      効いていなければ施設チェックは丸ごとバイパスされる。
//      SQLを読むだけでは「DROPが書いてある」ことしか分からないので、実DBで確かめる。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import {
  cleanupPriceHistoriesFixtures,
  createServiceRoleClient,
  seedPriceHistoriesFixtures,
  type SeedPriceHistoriesFixtures,
} from './helpers/seed-rls-idor'

// 約束カタログ（docs/agents/promise-catalog.md）: P-010 他施設は読めない / P-015 自施設は通る（対照）/ P-051 書き込みはトリガーのみ
// 不変条件カタログ（docs/agents/invariant-catalog.md）: I-041 価格履歴は値が変わったときだけ増え直接 INSERT できない
describe('price_histories RLS/IDOR・DB制約 [P-010 P-015 P-051 I-041]', () => {
  let fixtures: SeedPriceHistoriesFixtures

  beforeAll(async () => {
    fixtures = await seedPriceHistoriesFixtures()
  }, 60_000)

  afterAll(async () => {
    if (fixtures) {
      await cleanupPriceHistoriesFixtures(fixtures)
    }
  })

  describe('施設スコープの履歴（entity_type = hospital_price）', () => {
    it('他施設のユーザーは取得できない', async () => {
      const { data, error } = await fixtures.userB.client
        .from('price_histories')
        .select('id')
        .eq('id', fixtures.facilityScopedHistory.id)

      expect(error).toBeNull()
      expect(data).toEqual([])
    })

    it('自施設のユーザーは取得できる（対照。古い許可ポリシーの残存検知も兼ねる）', async () => {
      const { data, error } = await fixtures.userA.client
        .from('price_histories')
        .select('id')
        .eq('id', fixtures.facilityScopedHistory.id)

      expect(error).toBeNull()
      expect(data).toHaveLength(1)
    })
  })

  describe('マスタの履歴（entity_type = distributor_product）', () => {
    it('他施設のユーザーでも取得できる（テナント非分離。設計どおり）', async () => {
      // WHY: これが取れないなら、ポリシーが「全部拒否」に倒れているだけで
      //      上の「他施設から見えない」は何も証明していない
      const { data, error } = await fixtures.userB.client
        .from('price_histories')
        .select('id')
        .eq('id', fixtures.masterHistory.id)

      expect(error).toBeNull()
      expect(data).toHaveLength(1)
    })
  })

  describe('未ログイン（anon）からの読み取り', () => {
    // WHY(2026-09-11): 「価格の履歴はテナント非分離が設計」と書いてある表が、実際には
    //      **未認証にも**開いていた。RLS ポリシーは `TO anon, authenticated USING (true)`、
    //      GRANT も `TO anon`（20260622000000_add_price_histories.sql:22,28）。
    //      Supabase の REST は公開 URL と anon key だけで叩けるので、アプリの入口
    //      （`requireAuth` がある）を通らずに**ログインせず全施設の価格変更履歴が読めた**。
    //      台帳 TB-040 の「読み手」は `authenticated / service_role` で anon を含まないのに、
    //      実態と食い違っていた（C-010: 印を実態と突き合わせない）。
    //      掃き（table-boundary-sweep）の (A) は**その表に行が無ければ「読めなかった」と読む**ので、
    //      餌の無い実行では気づけなかった（C-021: 不在判定に対を置かない）。
    //      2026-09-11 に anon を締めた（20260911000000_revoke_price_history_anon_access.sql）。
    const anonClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    it('施設スコープの履歴は読めない', async () => {
      const { data } = await anonClient
        .from('price_histories')
        .select('id')
        .eq('id', fixtures.facilityScopedHistory.id)

      expect(data ?? []).toEqual([])
    })

    it('マスタの履歴（テナント非分離が設計）も読めない', async () => {
      // WHY: 締める前はここが 1 行返っていた（2026-09-11 実測）。
      //      施設で絞れないマスタであることと、未認証に開くことは別の話。
      const { data } = await anonClient
        .from('price_histories')
        .select('id')
        .eq('id', fixtures.masterHistory.id)

      expect(data ?? []).toEqual([])
    })

    it('価格履歴の RPC も呼べない', async () => {
      // WHY: 表を締めても RPC は SECURITY DEFINER で RLS を通らない。
      //      `GRANT EXECUTE ... TO anon`（同 migration:117）が残っていれば同じものが読める
      const { data, error } = await anonClient.rpc('get_distributor_product_price_history', {
        p_distributor_product_id: fixtures.distributorProduct.id,
      })

      expect(error, '未ログインで価格履歴の RPC が呼べてしまう').not.toBeNull()
      expect(data ?? []).toEqual([])
    })

    it('対照: 同じ行と同じ RPC を認証済みの利用者は使える（「全部拒否」で通っていない）', async () => {
      // WHY(C-021): 上の 3 つは「締まっている」場合と「そもそも誰にも返らない」場合の
      //      両方で成り立つ。同じ呼び出しがログイン済みで通ることを見て初めて意味が出る
      const { data: rows, error: rowsError } = await fixtures.userA.client
        .from('price_histories')
        .select('id')
        .eq('id', fixtures.masterHistory.id)
      expect(rowsError).toBeNull()
      expect(rows, '認証済みでもマスタの履歴が読めない').toHaveLength(1)

      const { data: rpcRows, error: rpcError } = await fixtures.userA.client.rpc(
        'get_distributor_product_price_history',
        { p_distributor_product_id: fixtures.distributorProduct.id }
      )
      expect(rpcError, '認証済みでも価格履歴の RPC が呼べない').toBeNull()
      expect((rpcRows ?? []).length, '認証済みでも RPC が空を返す（上の空に意味が無い）').toBeGreaterThan(0)
    })
  })

  describe('書き込みはトリガー経由のみ', () => {
    it('自施設のユーザーでも直接INSERTできない（price_histories_no_insert）', async () => {
      const { data, error } = await fixtures.userA.client
        .from('price_histories')
        .insert({
          entity_type: 'hospital_price',
          entity_id: fixtures.hospitalPriceA.id,
          distributor_product_id: fixtures.distributorProduct.id,
          field_name: 'purchase_price',
          old_value: 1,
          new_value: 2,
        })
        .select('id')

      expect(data).toBeNull()
      expect(error?.code).toBe('42501')
    })
  })

  describe('唯一の書き込み経路（SECURITY DEFINERトリガー）が正しい値を残す', () => {
    // WHY: price_histories の CHECK 制約（entity_type / field_name の許可値）は、
    //      **どのクライアント経路からも違反させられない**。GRANT が SELECT のみで、
    //      service_role でも直接INSERTできず（実測: permission denied）、
    //      唯一の書き手である SECURITY DEFINER トリガーは固定リテラルを渡すため。
    //      よって「制約を破ろうとして弾かれる」形の検証は成立しない。
    //      代わりに、実際に守るべき約束＝**トリガーが正しい履歴を残すこと**を確かめる。
    //      （CHECK制約自体は将来の書き手に対する多層防御として残る）
    const db = createServiceRoleClient()

    it('hospital_prices の購入価格を変えると、施設スコープの履歴が正しい内容で残る', async () => {
      const before = fixtures.hospitalPriceA.purchasePrice + 1 // シードで1度更新済み
      const after = before + 500

      const { error: updateError } = await db
        .from('hospital_prices')
        .update({ purchase_price: after })
        .eq('id', fixtures.hospitalPriceA.id)
      expect(updateError).toBeNull()

      const { data } = await db
        .from('price_histories')
        .select('entity_type, field_name, old_value, new_value')
        .eq('entity_id', fixtures.hospitalPriceA.id)
        .eq('new_value', after)
        .single()

      expect(data).toMatchObject({
        entity_type: 'hospital_price',
        field_name: 'purchase_price',
        old_value: before,
        new_value: after,
      })
    })

    it('価格を変えない更新では履歴が増えない（IS DISTINCT FROM の確認）', async () => {
      // WHY: これが無いと、更新のたびに履歴が増える実装でも上のテストは通ってしまう
      const countRows = async () => {
        const { data } = await db
          .from('price_histories')
          .select('id')
          .eq('entity_id', fixtures.hospitalPriceA.id)
        return data?.length ?? 0
      }

      const before = await countRows()
      await db
        .from('hospital_prices')
        .update({ delivery_price: 23456 }) // シードと同じ値＝実質変化なし
        .eq('id', fixtures.hospitalPriceA.id)

      expect(await countRows()).toBe(before)
    })
  })
})
