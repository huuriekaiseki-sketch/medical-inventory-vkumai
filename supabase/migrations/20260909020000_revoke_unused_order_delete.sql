-- supabase/migrations/20260909020000_revoke_unused_order_delete.sql
-- release-order: db-first
-- design: 権限=**施設の writer から DELETE を外す**（発注・返却とその明細の 8 表。人の判断、2026-09-09）／
--         大きさ・量は変えない（列も表も増やさない）／消えるとき=**消さない**（削除ではなく
--         取り消し状態にする、E-056 の判断のとおり）／記録=既存の監査トリガーのまま／外部送信なし
-- cardinality: many
--
-- WHY(使っていない権限を剥がす): 2026-09-09 に「**DB は書けるのにアプリに道が無い**」組み合わせを
--      機械で数えたところ 20 件あった（`scripts/lib/check-write-path-gaps.mjs`）。
--      そのうち 8 件が**この 8 表の DELETE** で、アプリは 1 か所もこれらの表を削除しない。
--      E-056 の判断で「間違えた発注・返却は削除ではなく取り消し状態にする」と決めてあるので、
--      削除の道は**これから先も作らない**。
--
--      使っていない権限が残っていると、セッションを奪われたときの到達範囲が製品の見た目より広い。
--      画面にボタンが無いことは防御ではない（API を直接叩けば DB が通す）。
--
-- WHY(ポリシーをコマンド別に割る): `facility_writer_or_admin` は `FOR ALL` で 4 コマンドを覆っている。
--      権限だけ剥がすと「**ポリシーはあるのに権限が無い**」状態になり、
--      書いたポリシーが一度も評価されない（`scan-rls-grant-gaps.mjs` が検知する形）。
--      INSERT と UPDATE の 2 本に割り、DELETE は**ポリシーも権限も無い**状態にする。
--
-- WHY(SELECT を割らなくてよい): 読みは別のポリシー `facility_member_or_admin`（FOR SELECT）が
--      覆っている。writer は member に含まれるので、writer 側から SELECT が外れても読めなくならない。
--      実測は `supabase/__tests__/integration/` の境界テストが行う。
--
-- WHY(条件は 20260806000002 の版をそのまま写す・E-064): ポリシーも関数と同じで、
--      古い版を元に書き直すと後から入った守り（`has_aal2()`）が黙って落ちる。
--      ここでは**最後に定義した版**（20260806000002）の USING / WITH CHECK を 1 文字も変えずに
--      INSERT 用と UPDATE 用へ写している。判定を変える変更ではない。
--
-- WHY(INSERT の権限は残す): 発注の作成は SECURITY DEFINER の RPC が行うので理屈上は余剰だが、
--      `require-aal2-in-facility-writer-rls.integration.test.ts` が**利用者のクライアントで
--      直接 INSERT して aal2 の境界を測っている**。剥がすとその測定ができなくなる。
--      作成の権限をどうするかは別途決める（登録簿 `write-path-registry.json` に隙間として残る）。
--
-- 対象外: `consumables` / `hospital_prices` / `products` / `categories` /
--      `distributor_products` / `product_compatibilities` / `user_facilities` の DELETE は
--      アプリが実際に使っている（消せる道が製品にある）。`facilities` は 20260908050000 で剥がし済み。
--
-- ROLLBACK:
--   -- 8 表それぞれについて（<t> と <条件> は下記の CREATE POLICY と同じもの）
--   DROP POLICY IF EXISTS "facility_writer_or_admin_insert" ON <t>;
--   DROP POLICY IF EXISTS "facility_writer_or_admin_update" ON <t>;
--   CREATE POLICY "facility_writer_or_admin" ON <t> FOR ALL TO authenticated
--     USING (<条件>) WITH CHECK (<条件>);
--   GRANT DELETE ON TABLE <t> TO authenticated;

-- =========================================================================
-- 1) 発注 3 種と返却（facility_id を直接持つ 4 表）
-- =========================================================================
DROP POLICY IF EXISTS "facility_writer_or_admin" ON case_orders;
CREATE POLICY "facility_writer_or_admin_insert" ON case_orders
  FOR INSERT TO authenticated
  WITH CHECK ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2());
CREATE POLICY "facility_writer_or_admin_update" ON case_orders
  FOR UPDATE TO authenticated
  USING ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2())
  WITH CHECK ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2());
REVOKE DELETE ON TABLE case_orders FROM authenticated;

DROP POLICY IF EXISTS "facility_writer_or_admin" ON consumable_orders;
CREATE POLICY "facility_writer_or_admin_insert" ON consumable_orders
  FOR INSERT TO authenticated
  WITH CHECK ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2());
CREATE POLICY "facility_writer_or_admin_update" ON consumable_orders
  FOR UPDATE TO authenticated
  USING ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2())
  WITH CHECK ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2());
REVOKE DELETE ON TABLE consumable_orders FROM authenticated;

DROP POLICY IF EXISTS "facility_writer_or_admin" ON loan_orders;
CREATE POLICY "facility_writer_or_admin_insert" ON loan_orders
  FOR INSERT TO authenticated
  WITH CHECK ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2());
CREATE POLICY "facility_writer_or_admin_update" ON loan_orders
  FOR UPDATE TO authenticated
  USING ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2())
  WITH CHECK ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2());
REVOKE DELETE ON TABLE loan_orders FROM authenticated;

DROP POLICY IF EXISTS "facility_writer_or_admin" ON loan_returns;
CREATE POLICY "facility_writer_or_admin_insert" ON loan_returns
  FOR INSERT TO authenticated
  WITH CHECK ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2());
CREATE POLICY "facility_writer_or_admin_update" ON loan_returns
  FOR UPDATE TO authenticated
  USING ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2())
  WITH CHECK ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2());
REVOKE DELETE ON TABLE loan_returns FROM authenticated;

-- =========================================================================
-- 2) 明細 4 表（親を EXISTS で引く）
-- =========================================================================
DROP POLICY IF EXISTS "facility_writer_or_admin" ON case_order_items;
CREATE POLICY "facility_writer_or_admin_insert" ON case_order_items
  FOR INSERT TO authenticated
  WITH CHECK (
    has_aal2() AND EXISTS (
      SELECT 1 FROM case_orders o
      WHERE o.id = case_order_items.case_order_id
        AND (is_facility_writer(o.facility_id) OR is_admin())
    )
  );
CREATE POLICY "facility_writer_or_admin_update" ON case_order_items
  FOR UPDATE TO authenticated
  USING (
    has_aal2() AND EXISTS (
      SELECT 1 FROM case_orders o
      WHERE o.id = case_order_items.case_order_id
        AND (is_facility_writer(o.facility_id) OR is_admin())
    )
  )
  WITH CHECK (
    has_aal2() AND EXISTS (
      SELECT 1 FROM case_orders o
      WHERE o.id = case_order_items.case_order_id
        AND (is_facility_writer(o.facility_id) OR is_admin())
    )
  );
REVOKE DELETE ON TABLE case_order_items FROM authenticated;

DROP POLICY IF EXISTS "facility_writer_or_admin" ON consumable_order_items;
CREATE POLICY "facility_writer_or_admin_insert" ON consumable_order_items
  FOR INSERT TO authenticated
  WITH CHECK (
    has_aal2() AND EXISTS (
      SELECT 1 FROM consumable_orders o
      WHERE o.id = consumable_order_items.consumable_order_id
        AND (is_facility_writer(o.facility_id) OR is_admin())
    )
  );
CREATE POLICY "facility_writer_or_admin_update" ON consumable_order_items
  FOR UPDATE TO authenticated
  USING (
    has_aal2() AND EXISTS (
      SELECT 1 FROM consumable_orders o
      WHERE o.id = consumable_order_items.consumable_order_id
        AND (is_facility_writer(o.facility_id) OR is_admin())
    )
  )
  WITH CHECK (
    has_aal2() AND EXISTS (
      SELECT 1 FROM consumable_orders o
      WHERE o.id = consumable_order_items.consumable_order_id
        AND (is_facility_writer(o.facility_id) OR is_admin())
    )
  );
REVOKE DELETE ON TABLE consumable_order_items FROM authenticated;

DROP POLICY IF EXISTS "facility_writer_or_admin" ON loan_order_items;
CREATE POLICY "facility_writer_or_admin_insert" ON loan_order_items
  FOR INSERT TO authenticated
  WITH CHECK (
    has_aal2() AND EXISTS (
      SELECT 1 FROM loan_orders o
      WHERE o.id = loan_order_items.loan_order_id
        AND (is_facility_writer(o.facility_id) OR is_admin())
    )
  );
CREATE POLICY "facility_writer_or_admin_update" ON loan_order_items
  FOR UPDATE TO authenticated
  USING (
    has_aal2() AND EXISTS (
      SELECT 1 FROM loan_orders o
      WHERE o.id = loan_order_items.loan_order_id
        AND (is_facility_writer(o.facility_id) OR is_admin())
    )
  )
  WITH CHECK (
    has_aal2() AND EXISTS (
      SELECT 1 FROM loan_orders o
      WHERE o.id = loan_order_items.loan_order_id
        AND (is_facility_writer(o.facility_id) OR is_admin())
    )
  );
REVOKE DELETE ON TABLE loan_order_items FROM authenticated;

DROP POLICY IF EXISTS "facility_writer_or_admin" ON loan_return_items;
CREATE POLICY "facility_writer_or_admin_insert" ON loan_return_items
  FOR INSERT TO authenticated
  WITH CHECK (
    has_aal2() AND EXISTS (
      SELECT 1 FROM loan_returns o
      WHERE o.id = loan_return_items.loan_return_id
        AND (is_facility_writer(o.facility_id) OR is_admin())
    )
  );
CREATE POLICY "facility_writer_or_admin_update" ON loan_return_items
  FOR UPDATE TO authenticated
  USING (
    has_aal2() AND EXISTS (
      SELECT 1 FROM loan_returns o
      WHERE o.id = loan_return_items.loan_return_id
        AND (is_facility_writer(o.facility_id) OR is_admin())
    )
  )
  WITH CHECK (
    has_aal2() AND EXISTS (
      SELECT 1 FROM loan_returns o
      WHERE o.id = loan_return_items.loan_return_id
        AND (is_facility_writer(o.facility_id) OR is_admin())
    )
  );
REVOKE DELETE ON TABLE loan_return_items FROM authenticated;

-- テーブルの新設・削除ではないため refresh_schema_baseline_snapshot の呼び出しは不要。
