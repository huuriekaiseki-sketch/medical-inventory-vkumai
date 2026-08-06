-- supabase/migrations/20260806000002_require_aal2_in_facility_writer_rls.sql
-- WHY: issue #623。20260806000001でcreate_case_order_atomic等4RPCの内部にhas_aal2()
--      チェックを追加したが、これらのテーブル自体のRLSポリシー(facility_writer_or_admin)
--      はis_facility_writer(facility_id) OR is_admin()のみで、aal2判定を一切含んで
--      いなかった。Next.jsアプリは常にRPC経由で発注するため気づかないが、PostgRESTの
--      POST /rest/v1/case_orders のようにRPCを経由せずテーブルへ直接INSERTすれば、
--      aal1のセッションのままでも発注データを書き込める。20260806000001が「middlewareを
--      迂回して直接Supabase APIを叩く経路をDB層で塞ぐ」ことを目的としていたにもかかわらず、
--      発注テーブル自体のRLSではこの経路が塞がっていなかった(RPC内チェックのみでは、
--      RPCを経由しない直接書き込みを防げない)。
--
-- WHY(対象範囲・facilitiesを除外する理由): facility_writer_or_admin系ポリシーが付与
--      されている全テーブル(発注/返却4テーブル+items4テーブル+hospital_prices+
--      consumables)にhas_aal2()を追加する。facilities(UPDATE、施設名変更のみ)は
--      対象外とした。金額・在庫の移動を伴わない純粋な管理操作であり、issue #612の
--      「金額・在庫に影響する書き込み操作に限定する」という線引きに該当しないため。
--      hospital_prices・consumablesは#612時点では対象外だったが、issue #619の
--      検討で「価格改定は金額に直結し、かつ発注同様に低頻度の操作」と判断し、
--      本migrationで対象に含めた(consumablesテーブルは在庫数を持たずname/jan/purpose
--      のみのカタログであるため、頻繁な編集を想定した運用ではない)。
--
-- WHY(RPC内の既存has_aal2()チェックを削除しない理由): RLSとRPC両方でのチェックは
--      冗長になるが、defense-in-depthとしてこのリポジトリの既存パターン(is_facility_writer
--      もRLSとRPC両方でチェックしている)と一致するため、RPC側のチェックは残す。

-- =========================================================================
-- 発注/返却系4テーブル
-- =========================================================================
DROP POLICY IF EXISTS "facility_writer_or_admin" ON consumable_orders;
CREATE POLICY "facility_writer_or_admin" ON consumable_orders
  FOR ALL TO authenticated
  USING ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2())
  WITH CHECK ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2());

DROP POLICY IF EXISTS "facility_writer_or_admin" ON case_orders;
CREATE POLICY "facility_writer_or_admin" ON case_orders
  FOR ALL TO authenticated
  USING ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2())
  WITH CHECK ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2());

DROP POLICY IF EXISTS "facility_writer_or_admin" ON loan_orders;
CREATE POLICY "facility_writer_or_admin" ON loan_orders
  FOR ALL TO authenticated
  USING ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2())
  WITH CHECK ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2());

DROP POLICY IF EXISTS "facility_writer_or_admin" ON loan_returns;
CREATE POLICY "facility_writer_or_admin" ON loan_returns
  FOR ALL TO authenticated
  USING ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2())
  WITH CHECK ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2());

-- =========================================================================
-- 価格・カタログ2テーブル(issue #619で対象に含めると判断)
-- =========================================================================
DROP POLICY IF EXISTS "facility_writer_or_admin" ON hospital_prices;
CREATE POLICY "facility_writer_or_admin" ON hospital_prices
  FOR ALL TO authenticated
  USING ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2())
  WITH CHECK ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2());

DROP POLICY IF EXISTS "facility_writer_or_admin" ON consumables;
CREATE POLICY "facility_writer_or_admin" ON consumables
  FOR ALL TO authenticated
  USING ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2())
  WITH CHECK ((is_facility_writer(facility_id) OR is_admin()) AND has_aal2());

-- =========================================================================
-- items系4テーブル(親order経由でfacility_idを引くEXISTSパターン)
-- =========================================================================
DROP POLICY IF EXISTS "facility_writer_or_admin" ON case_order_items;
CREATE POLICY "facility_writer_or_admin" ON case_order_items
  FOR ALL TO authenticated
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

DROP POLICY IF EXISTS "facility_writer_or_admin" ON consumable_order_items;
CREATE POLICY "facility_writer_or_admin" ON consumable_order_items
  FOR ALL TO authenticated
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

DROP POLICY IF EXISTS "facility_writer_or_admin" ON loan_order_items;
CREATE POLICY "facility_writer_or_admin" ON loan_order_items
  FOR ALL TO authenticated
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

DROP POLICY IF EXISTS "facility_writer_or_admin" ON loan_return_items;
CREATE POLICY "facility_writer_or_admin" ON loan_return_items
  FOR ALL TO authenticated
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
