-- supabase/migrations/20260629000003_add_indexes.sql
-- WHY: facility_id / category_id / entity_id での絞り込みクエリが頻発するため、
--      該当カラムにインデックスを追加してフルスキャンを避ける(SPEC-tech-debt.md インデックス追加)。

CREATE INDEX IF NOT EXISTS idx_hospital_prices_facility_id ON hospital_prices(facility_id);
CREATE INDEX IF NOT EXISTS idx_consumables_facility_id ON consumables(facility_id);
CREATE INDEX IF NOT EXISTS idx_distributor_products_category_id ON distributor_products(category_id);
CREATE INDEX IF NOT EXISTS idx_price_histories_entity_id ON price_histories(entity_id);
CREATE INDEX IF NOT EXISTS idx_user_facilities_facility_id ON user_facilities(facility_id);
