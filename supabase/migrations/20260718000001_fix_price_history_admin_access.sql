-- supabase/migrations/20260718000001_fix_price_history_admin_access.sql
-- issue #458: get_distributor_product_price_history RPC(SECURITY DEFINER)が
-- adminの全施設閲覧権限を無視している。
--
-- WHY: 20260627010000_add_multitenant.sqlでこのRPCが定義された時点ではis_admin()が
-- まだ存在せず(is_admin()は翌日の20260628010000_add_role_to_user_facilities.sqlで新設)、
-- 翌日の20260628010001_update_rls_admin.sqlで全RLSポリシーにOR is_admin()が追加された際、
-- このRPCはRLSポリシーではなくSECURITY DEFINER関数内の手書きWHERE句のため、その一斉更新の
-- 対象から漏れていた。hospital_prices本体のRLS(is_facility_member(facility_id) OR is_admin())
-- と挙動を揃える。

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
    AND (is_facility_member(hp.facility_id) OR is_admin())

  ORDER BY changed_at DESC;
$$;

-- カラム追加・テーブル新設/削除ではないため refresh_schema_baseline_snapshot は不要
-- (issue #305要件の対象外。20260715000001_add_unit_price_to_order_items.sqlと同じ判断)
