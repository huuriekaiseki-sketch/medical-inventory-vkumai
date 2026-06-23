-- supabase/migrations/20260623000000_add_price_rates.sql
--
-- hospital_prices に粗利・仕入れ掛け率・納入掛け率を追加する。
--
-- gross_profit  = delivery_price - purchase_price（generated column で常に最新）
-- purchase_rate = purchase_price / reimbursement_price（別テーブル参照のためトリガー管理）
-- delivery_rate = delivery_price  / reimbursement_price（同上）
-- reimbursement_price が NULL または 0 の場合は NULL を格納する。

-- ① カラム追加
ALTER TABLE hospital_prices
  ADD COLUMN gross_profit   NUMERIC GENERATED ALWAYS AS (delivery_price - purchase_price) STORED,
  ADD COLUMN purchase_rate  NUMERIC,
  ADD COLUMN delivery_rate  NUMERIC;

-- ② hospital_prices の INSERT / UPDATE 時に掛け率を計算するトリガー関数
CREATE OR REPLACE FUNCTION compute_hospital_price_rates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_reimbursement_price NUMERIC;
BEGIN
  SELECT reimbursement_price
    INTO v_reimbursement_price
    FROM distributor_products
   WHERE id = NEW.distributor_product_id;

  IF v_reimbursement_price IS NOT NULL AND v_reimbursement_price <> 0 THEN
    NEW.purchase_rate := NEW.purchase_price / v_reimbursement_price;
    NEW.delivery_rate := NEW.delivery_price  / v_reimbursement_price;
  ELSE
    NEW.purchase_rate := NULL;
    NEW.delivery_rate := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_hospital_prices_compute_rates
  BEFORE INSERT OR UPDATE ON hospital_prices
  FOR EACH ROW
  EXECUTE FUNCTION compute_hospital_price_rates();

-- ③ distributor_products の reimbursement_price 変更時に関連する hospital_prices を一括更新
CREATE OR REPLACE FUNCTION propagate_reimbursement_price_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.reimbursement_price IS DISTINCT FROM NEW.reimbursement_price THEN
    UPDATE hospital_prices
    SET
      purchase_rate = CASE
        WHEN NEW.reimbursement_price IS NOT NULL AND NEW.reimbursement_price <> 0
        THEN purchase_price / NEW.reimbursement_price
        ELSE NULL
      END,
      delivery_rate = CASE
        WHEN NEW.reimbursement_price IS NOT NULL AND NEW.reimbursement_price <> 0
        THEN delivery_price / NEW.reimbursement_price
        ELSE NULL
      END
    WHERE distributor_product_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_distributor_products_propagate_rates
  AFTER UPDATE ON distributor_products
  FOR EACH ROW
  EXECUTE FUNCTION propagate_reimbursement_price_change();

-- ④ 既存データの初期化（トリガーを経由させて掛け率を計算する）
UPDATE hospital_prices SET purchase_price = purchase_price;
