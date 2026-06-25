-- supabase/migrations/20260626000000_fix_fk_and_indexes.sql
-- FK 修正・複合インデックス追加・order items への updated_at 追加。
-- すべて冪等（再実行しても失敗しない）に記述する。

-- =========================================================================
-- 1. distributor_products.category_id FK に ON DELETE CASCADE を追加
--    既存 FK 名は自動生成の distributor_products_category_id_fkey。
--    DROP は IF EXISTS で冪等にし、ADD は DO ブロックで存在チェックする。
-- =========================================================================
ALTER TABLE distributor_products
  DROP CONSTRAINT IF EXISTS distributor_products_category_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'distributor_products_category_id_fkey'
  ) THEN
    ALTER TABLE distributor_products
      ADD CONSTRAINT distributor_products_category_id_fkey
        FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE;
  END IF;
END
$$;

-- =========================================================================
-- 2. case_order_items / loan_order_items / loan_return_items の jan を
--    products(jan) への FK にする。products.jan は UNIQUE のため参照可能。
--    既存データに孤児 jan があっても適用できるよう NOT VALID で追加する。
--    （新規行のみ検証され、既存行は将来 VALIDATE CONSTRAINT で検証可能）
-- =========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'case_order_items_jan_fkey'
  ) THEN
    ALTER TABLE case_order_items
      ADD CONSTRAINT case_order_items_jan_fkey
        FOREIGN KEY (jan) REFERENCES products (jan) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'loan_order_items_jan_fkey'
  ) THEN
    ALTER TABLE loan_order_items
      ADD CONSTRAINT loan_order_items_jan_fkey
        FOREIGN KEY (jan) REFERENCES products (jan) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'loan_return_items_jan_fkey'
  ) THEN
    ALTER TABLE loan_return_items
      ADD CONSTRAINT loan_return_items_jan_fkey
        FOREIGN KEY (jan) REFERENCES products (jan) NOT VALID;
  END IF;
END
$$;

-- =========================================================================
-- 3. 複合インデックス（一覧フィルタ用）。CREATE INDEX IF NOT EXISTS で冪等。
-- =========================================================================
CREATE INDEX IF NOT EXISTS idx_case_orders_facility_status ON case_orders (facility_id, status);
CREATE INDEX IF NOT EXISTS idx_case_orders_facility_created_at ON case_orders (facility_id, created_at);
CREATE INDEX IF NOT EXISTS idx_consumable_orders_facility_status ON consumable_orders (facility_id, status);
CREATE INDEX IF NOT EXISTS idx_loan_orders_facility_status ON loan_orders (facility_id, status);
CREATE INDEX IF NOT EXISTS idx_loan_returns_facility_status ON loan_returns (facility_id, status);

-- =========================================================================
-- 4. order items 3テーブルに updated_at を追加（ADD COLUMN IF NOT EXISTS）。
--    既存行も DEFAULT now() で埋まる。更新時刻の自動更新トリガも付与する。
-- =========================================================================
ALTER TABLE case_order_items
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE loan_order_items
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE loan_return_items
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- updated_at 自動更新トリガ（既存なら張り直して冪等にする）
DROP TRIGGER IF EXISTS case_order_items_updated_at ON case_order_items;
CREATE TRIGGER case_order_items_updated_at
  BEFORE UPDATE ON case_order_items
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

DROP TRIGGER IF EXISTS loan_order_items_updated_at ON loan_order_items;
CREATE TRIGGER loan_order_items_updated_at
  BEFORE UPDATE ON loan_order_items
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

DROP TRIGGER IF EXISTS loan_return_items_updated_at ON loan_return_items;
CREATE TRIGGER loan_return_items_updated_at
  BEFORE UPDATE ON loan_return_items
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();
