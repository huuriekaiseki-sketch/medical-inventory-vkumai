-- supabase/migrations/20260626001000_enable_rls.sql
-- WHY: 全テーブルに RLS を有効化し、認証ユーザーのみアクセス可能にする。
--      anon ロールの直接テーブルアクセスを REVOKE で遮断する。
--      また SECURITY DEFINER 関数に SET search_path = public を追加し
--      search_path インジェクションを防ぐ。

-- =========================================================================
-- 1. 全テーブルの RLS 有効化
-- =========================================================================
ALTER TABLE products                ENABLE ROW LEVEL SECURITY;
ALTER TABLE facilities              ENABLE ROW LEVEL SECURITY;
ALTER TABLE distributor_products    ENABLE ROW LEVEL SECURITY;
ALTER TABLE hospital_prices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories              ENABLE ROW LEVEL SECURITY;
-- price_histories は 20260622 で既に ENABLE 済みのためスキップ
ALTER TABLE case_orders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_order_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumables             ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumable_orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumable_order_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_orders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_order_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_returns            ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_return_items       ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- 2. 認証ユーザーのみ許可するポリシー（冪等: DROP IF EXISTS してから CREATE）
-- =========================================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'products', 'facilities', 'distributor_products', 'hospital_prices',
    'categories', 'case_orders', 'case_order_items',
    'consumables', 'consumable_orders', 'consumable_order_items',
    'loan_orders', 'loan_order_items', 'loan_returns', 'loan_return_items'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "auth_only" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "auth_only" ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t
    );
  END LOOP;
END
$$;

-- price_histories は 20260622 で作成した旧ポリシーを削除してから再作成
-- WHY: 旧ポリシー名 (price_histories_select / price_histories_no_insert) が残存すると
--      新ポリシー "auth_only" と競合するため明示的に DROP する
DROP POLICY IF EXISTS "price_histories_select" ON price_histories;
DROP POLICY IF EXISTS "price_histories_no_insert" ON price_histories;
DROP POLICY IF EXISTS "auth_only" ON price_histories;
CREATE POLICY "auth_only" ON price_histories
  FOR SELECT TO authenticated USING (true);

-- =========================================================================
-- 3. anon ロールのテーブル直接アクセスを REVOKE
-- =========================================================================
REVOKE ALL ON products               FROM anon;
REVOKE ALL ON facilities             FROM anon;
REVOKE ALL ON distributor_products   FROM anon;
REVOKE ALL ON hospital_prices        FROM anon;
REVOKE ALL ON categories             FROM anon;
REVOKE ALL ON price_histories        FROM anon;
REVOKE ALL ON case_orders            FROM anon;
REVOKE ALL ON case_order_items       FROM anon;
REVOKE ALL ON consumables            FROM anon;
REVOKE ALL ON consumable_orders      FROM anon;
REVOKE ALL ON consumable_order_items FROM anon;
REVOKE ALL ON loan_orders            FROM anon;
REVOKE ALL ON loan_order_items       FROM anon;
REVOKE ALL ON loan_returns           FROM anon;
REVOKE ALL ON loan_return_items      FROM anon;

-- =========================================================================
-- 4. SECURITY DEFINER 関数に SET search_path = public を追加
--    WHY: search_path を固定することで悪意ある schema の上書きを防ぐ
-- =========================================================================

-- get_distributor_product_price_history
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

  ORDER BY changed_at DESC;
$$;

-- trg_distributor_products_price_history (SET search_path 追加)
CREATE OR REPLACE FUNCTION trg_distributor_products_price_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.reimbursement_price IS DISTINCT FROM OLD.reimbursement_price THEN
    INSERT INTO price_histories
      (entity_type, entity_id, distributor_product_id, field_name, old_value, new_value)
    VALUES
      ('distributor_product', NEW.id, NEW.id, 'reimbursement_price',
       OLD.reimbursement_price, NEW.reimbursement_price);
  END IF;
  RETURN NEW;
END;
$$;

-- trg_hospital_prices_price_history (SET search_path 追加)
CREATE OR REPLACE FUNCTION trg_hospital_prices_price_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.purchase_price IS DISTINCT FROM OLD.purchase_price THEN
    INSERT INTO price_histories
      (entity_type, entity_id, distributor_product_id, field_name, old_value, new_value)
    VALUES
      ('hospital_price', NEW.id, NEW.distributor_product_id, 'purchase_price',
       OLD.purchase_price, NEW.purchase_price);
  END IF;
  IF NEW.delivery_price IS DISTINCT FROM OLD.delivery_price THEN
    INSERT INTO price_histories
      (entity_type, entity_id, distributor_product_id, field_name, old_value, new_value)
    VALUES
      ('hospital_price', NEW.id, NEW.distributor_product_id, 'delivery_price',
       OLD.delivery_price, NEW.delivery_price);
  END IF;
  RETURN NEW;
END;
$$;
