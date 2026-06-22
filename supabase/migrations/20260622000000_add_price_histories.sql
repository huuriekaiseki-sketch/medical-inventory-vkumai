-- supabase/migrations/20260622000000_add_price_histories.sql

-- ① price_histories テーブル
CREATE TABLE price_histories (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type            TEXT NOT NULL CHECK (entity_type IN ('distributor_product', 'hospital_price')),
  entity_id              UUID NOT NULL,
  distributor_product_id UUID NOT NULL,
  field_name             TEXT NOT NULL CHECK (field_name IN ('reimbursement_price', 'purchase_price', 'delivery_price')),
  old_value              NUMERIC,
  new_value              NUMERIC,
  changed_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_price_histories_distributor_product ON price_histories (distributor_product_id);
CREATE INDEX idx_price_histories_entity ON price_histories (entity_type, entity_id);

-- ② RLS: anon/authenticated は SELECT のみ。INSERT はトリガー経由（SECURITY DEFINER）
ALTER TABLE price_histories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "price_histories_select" ON price_histories
  FOR SELECT TO anon, authenticated USING (true);

-- INSERT は RLS ポリシーで明示的に拒否（SECURITY DEFINER 関数は RLS をバイパスするため INSERT 可能）
CREATE POLICY "price_histories_no_insert" ON price_histories
  FOR INSERT TO anon, authenticated WITH CHECK (false);

GRANT SELECT ON price_histories TO anon, authenticated, service_role;

-- NOTE: service_role は Supabase の設計上 RLS をバイパスする。
-- 通常の API クライアント（anon/authenticated）からの直接 INSERT は上記ポリシーで拒否される。
-- service_role 経由の管理操作（マイグレーション・バックフィル等）は許容する設計とする。

-- ③ distributor_products トリガー: reimbursement_price 変更検知
CREATE OR REPLACE FUNCTION trg_distributor_products_price_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
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

CREATE TRIGGER distributor_products_price_history
AFTER UPDATE ON distributor_products
FOR EACH ROW EXECUTE FUNCTION trg_distributor_products_price_history();

-- ④ hospital_prices トリガー: purchase_price / delivery_price 変更検知
CREATE OR REPLACE FUNCTION trg_hospital_prices_price_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
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

CREATE TRIGGER hospital_prices_price_history
AFTER UPDATE ON hospital_prices
FOR EACH ROW EXECUTE FUNCTION trg_hospital_prices_price_history();

-- ⑤ RPC 関数: UNION クエリで distributor_product に紐づく全履歴を返す
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
) LANGUAGE sql SECURITY DEFINER AS $$
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

GRANT EXECUTE ON FUNCTION get_distributor_product_price_history TO anon, authenticated, service_role;
