-- supabase/migrations/20260628010001_update_rls_admin.sql
-- WHY: 既存の facility_member_only ポリシーは admin でも自施設しか見えない。
--      is_admin() を OR で追加した facility_member_or_admin に置き換え、
--      admin が全施設のデータにアクセスできるようにする（issue #4 のG2）。

-- =========================================================================
-- 1. 直接 facility_id を持つテーブル（FOR ALL）
--    静的検証しやすいよう明示的に展開している。
-- =========================================================================
DROP POLICY IF EXISTS "facility_member_only" ON consumable_orders;
CREATE POLICY "facility_member_or_admin" ON consumable_orders
  FOR ALL TO authenticated
  USING (is_facility_member(facility_id) OR is_admin())
  WITH CHECK (is_facility_member(facility_id) OR is_admin());

DROP POLICY IF EXISTS "facility_member_only" ON case_orders;
CREATE POLICY "facility_member_or_admin" ON case_orders
  FOR ALL TO authenticated
  USING (is_facility_member(facility_id) OR is_admin())
  WITH CHECK (is_facility_member(facility_id) OR is_admin());

DROP POLICY IF EXISTS "facility_member_only" ON loan_orders;
CREATE POLICY "facility_member_or_admin" ON loan_orders
  FOR ALL TO authenticated
  USING (is_facility_member(facility_id) OR is_admin())
  WITH CHECK (is_facility_member(facility_id) OR is_admin());

DROP POLICY IF EXISTS "facility_member_only" ON loan_returns;
CREATE POLICY "facility_member_or_admin" ON loan_returns
  FOR ALL TO authenticated
  USING (is_facility_member(facility_id) OR is_admin())
  WITH CHECK (is_facility_member(facility_id) OR is_admin());

DROP POLICY IF EXISTS "facility_member_only" ON hospital_prices;
CREATE POLICY "facility_member_or_admin" ON hospital_prices
  FOR ALL TO authenticated
  USING (is_facility_member(facility_id) OR is_admin())
  WITH CHECK (is_facility_member(facility_id) OR is_admin());

DROP POLICY IF EXISTS "facility_member_only" ON consumables;
CREATE POLICY "facility_member_or_admin" ON consumables
  FOR ALL TO authenticated
  USING (is_facility_member(facility_id) OR is_admin())
  WITH CHECK (is_facility_member(facility_id) OR is_admin());

-- =========================================================================
-- 2. facilities（SELECT / INSERT / UPDATE を分ける）
-- =========================================================================
DROP POLICY IF EXISTS "facility_member_only" ON facilities;
CREATE POLICY "facility_member_or_admin" ON facilities
  FOR SELECT TO authenticated
  USING (is_facility_member(id) OR is_admin());

-- WHY: POST /api/facilities は createServerSupabase（anon key）を使うため
--      INSERT ポリシーがないと admin でも施設作成が失敗する。
DROP POLICY IF EXISTS "admin_insert" ON facilities;
CREATE POLICY "admin_insert" ON facilities
  FOR INSERT TO authenticated
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "facility_member_update" ON facilities;
CREATE POLICY "facility_member_or_admin_update" ON facilities
  FOR UPDATE TO authenticated
  USING (is_facility_member(id) OR is_admin())
  WITH CHECK (is_facility_member(id) OR is_admin());

-- =========================================================================
-- 3. items テーブル（親 order 経由）
-- =========================================================================
DROP POLICY IF EXISTS "facility_member_only" ON case_order_items;
CREATE POLICY "facility_member_or_admin" ON case_order_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM case_orders o
    WHERE o.id = case_order_items.case_order_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM case_orders o
    WHERE o.id = case_order_items.case_order_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ));

DROP POLICY IF EXISTS "facility_member_only" ON consumable_order_items;
CREATE POLICY "facility_member_or_admin" ON consumable_order_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM consumable_orders o
    WHERE o.id = consumable_order_items.consumable_order_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM consumable_orders o
    WHERE o.id = consumable_order_items.consumable_order_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ));

DROP POLICY IF EXISTS "facility_member_only" ON loan_order_items;
CREATE POLICY "facility_member_or_admin" ON loan_order_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM loan_orders o
    WHERE o.id = loan_order_items.loan_order_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM loan_orders o
    WHERE o.id = loan_order_items.loan_order_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ));

DROP POLICY IF EXISTS "facility_member_only" ON loan_return_items;
CREATE POLICY "facility_member_or_admin" ON loan_return_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM loan_returns o
    WHERE o.id = loan_return_items.loan_return_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM loan_returns o
    WHERE o.id = loan_return_items.loan_return_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ));

-- =========================================================================
-- 4. price_histories（ポリモーフィック・SELECT のみ）
-- =========================================================================
DROP POLICY IF EXISTS "facility_member_only" ON price_histories;
CREATE POLICY "facility_member_or_admin" ON price_histories
  FOR SELECT TO authenticated
  USING (
    CASE
      WHEN entity_type = 'hospital_price' THEN
        EXISTS (
          SELECT 1 FROM hospital_prices hp
          WHERE hp.id = price_histories.entity_id
            AND (is_facility_member(hp.facility_id) OR is_admin())
        )
      WHEN entity_type = 'distributor_product' THEN true
      ELSE false
    END
  );
