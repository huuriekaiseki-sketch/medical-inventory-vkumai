-- supabase/migrations/20260627010000_add_multitenant.sql
-- WHY: user_facilities テーブルでユーザーと施設の対応を管理し、
--      RLS を施設メンバーのみに絞ることでデータ分離を実現する。
--      同一マイグレーション内で初期シード → ポリシー切り替えの順序を守る。

-- =========================================================================
-- 1. user_facilities テーブル
-- =========================================================================
CREATE TABLE user_facilities (
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  facility_id UUID REFERENCES facilities(id)  ON DELETE CASCADE,
  PRIMARY KEY (user_id, facility_id)
);
ALTER TABLE user_facilities ENABLE ROW LEVEL SECURITY;

-- 自分の行のみ SELECT 可（RLS サブクエリが空集合にならないために必須）
CREATE POLICY "self_read" ON user_facilities
  FOR SELECT TO authenticated USING (user_id = auth.uid());
-- 書き込みは service_role のみ（authenticated にポリシーなし = 書けない）

-- =========================================================================
-- 2. is_facility_member ヘルパー関数
-- =========================================================================
CREATE OR REPLACE FUNCTION is_facility_member(p_facility_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_facilities
    WHERE user_id = auth.uid() AND facility_id = p_facility_id
  );
$$;

-- =========================================================================
-- 3. 初期シード（現時点の全ユーザーを全施設に割り当て）
-- =========================================================================
-- 【初期シードのみ】現時点の全ユーザーを全施設に割り当て。
-- 本番ユーザーが増えた後にこのマイグレーションを再実行すると全員が全施設に入るため、
-- 本番適用前に対象ユーザーを条件で絞るか、このブロックを削除すること。
INSERT INTO user_facilities (user_id, facility_id)
SELECT u.id, f.id FROM auth.users u CROSS JOIN facilities f
ON CONFLICT DO NOTHING;

-- =========================================================================
-- 4. 施設固有・直接型テーブルの RLS ポリシーを切り替え
-- =========================================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hospital_prices', 'consumables',
    'case_orders', 'consumable_orders', 'loan_orders', 'loan_returns'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "auth_only" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "facility_member_only" ON %I FOR ALL TO authenticated ' ||
      'USING (is_facility_member(facility_id)) ' ||
      'WITH CHECK (is_facility_member(facility_id))',
      t
    );
  END LOOP;
END
$$;

-- facilities は SELECT/UPDATE のみ（INSERT は service_role = 管理者API経由）
DROP POLICY IF EXISTS "auth_only" ON facilities;
CREATE POLICY "facility_member_only" ON facilities
  FOR SELECT TO authenticated
  USING (is_facility_member(id));
CREATE POLICY "facility_member_update" ON facilities
  FOR UPDATE TO authenticated
  USING (is_facility_member(id))
  WITH CHECK (is_facility_member(id));

-- =========================================================================
-- 5. 施設固有・親参照型テーブル（*_items）の RLS ポリシーを切り替え
-- =========================================================================
DROP POLICY IF EXISTS "auth_only" ON case_order_items;
CREATE POLICY "facility_member_only" ON case_order_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM case_orders o
    WHERE o.id = case_order_items.case_order_id
      AND is_facility_member(o.facility_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM case_orders o
    WHERE o.id = case_order_items.case_order_id
      AND is_facility_member(o.facility_id)
  ));

DROP POLICY IF EXISTS "auth_only" ON consumable_order_items;
CREATE POLICY "facility_member_only" ON consumable_order_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM consumable_orders o
    WHERE o.id = consumable_order_items.consumable_order_id
      AND is_facility_member(o.facility_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM consumable_orders o
    WHERE o.id = consumable_order_items.consumable_order_id
      AND is_facility_member(o.facility_id)
  ));

DROP POLICY IF EXISTS "auth_only" ON loan_order_items;
CREATE POLICY "facility_member_only" ON loan_order_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM loan_orders o
    WHERE o.id = loan_order_items.loan_order_id
      AND is_facility_member(o.facility_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM loan_orders o
    WHERE o.id = loan_order_items.loan_order_id
      AND is_facility_member(o.facility_id)
  ));

DROP POLICY IF EXISTS "auth_only" ON loan_return_items;
CREATE POLICY "facility_member_only" ON loan_return_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM loan_returns r
    WHERE r.id = loan_return_items.loan_return_id
      AND is_facility_member(r.facility_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM loan_returns r
    WHERE r.id = loan_return_items.loan_return_id
      AND is_facility_member(r.facility_id)
  ));

-- =========================================================================
-- 6. price_histories（ポリモーフィック・SELECT のみ）
-- =========================================================================
DROP POLICY IF EXISTS "auth_only" ON price_histories;
CREATE POLICY "facility_member_only" ON price_histories
  FOR SELECT TO authenticated
  USING (
    CASE
      WHEN entity_type = 'hospital_price' THEN
        EXISTS (
          SELECT 1 FROM hospital_prices hp
          WHERE hp.id = price_histories.entity_id
            AND is_facility_member(hp.facility_id)
        )
      WHEN entity_type = 'distributor_product' THEN true
      ELSE false
    END
  );

-- =========================================================================
-- 7. get_distributor_product_price_history 関数に施設チェックを追加
-- =========================================================================
CREATE OR REPLACE FUNCTION get_distributor_product_price_history(
  p_distributor_product_id UUID
)
RETURNS TABLE (
  id                     UUID,
  entity_type            TEXT,
  entity_id              UUID,
  dist_product_id        UUID,
  field_name             TEXT,
  old_value              NUMERIC,
  new_value              NUMERIC,
  changed_at             TIMESTAMPTZ,
  facility_name          TEXT
) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT
    ph.id, ph.entity_type, ph.entity_id, ph.distributor_product_id AS dist_product_id,
    ph.field_name, ph.old_value, ph.new_value, ph.changed_at,
    NULL::TEXT AS facility_name
  FROM price_histories ph
  WHERE ph.entity_type = 'distributor_product'
    AND ph.distributor_product_id = p_distributor_product_id

  UNION ALL

  SELECT
    ph.id, ph.entity_type, ph.entity_id, ph.distributor_product_id AS dist_product_id,
    ph.field_name, ph.old_value, ph.new_value, ph.changed_at,
    f.name AS facility_name
  FROM price_histories ph
  LEFT JOIN hospital_prices hp ON hp.id = ph.entity_id
  LEFT JOIN facilities f ON f.id = hp.facility_id
  WHERE ph.entity_type = 'hospital_price'
    AND ph.distributor_product_id = p_distributor_product_id
    AND is_facility_member(hp.facility_id)

  ORDER BY changed_at DESC;
$$;
