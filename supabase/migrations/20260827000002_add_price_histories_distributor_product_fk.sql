-- supabase/migrations/20260827000002_add_price_histories_distributor_product_fk.sql

-- WHY: issue #669。price_histories.distributor_product_id にFK制約が無く、
-- PostgRESTのスキーマキャッシュが price_histories ⇔ distributor_products の関係を
-- 解決できなかった（"Could not find a relationship between 'price_histories' and
-- 'distributor_products' in the schema cache"）。src/lib/price-histories/repository.ts の
-- listRecentPriceHistories() が select('...,distributor_products(name)') という
-- PostgRESTの埋め込みJOIN構文を使っているが、これはFK制約が無いと解決できない。
--
-- 既存データに孤児行（参照先のdistributor_productsが後から削除された行）が
-- 混ざっている可能性があるため、20260626000000_fix_fk_and_indexes.sqlと同じ方針で
-- NOT VALID で追加し、新規行のみ即座に検証する（既存行は将来VALIDATE CONSTRAINTで検証可能）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'price_histories_distributor_product_id_fkey'
  ) THEN
    ALTER TABLE price_histories
      ADD CONSTRAINT price_histories_distributor_product_id_fkey
        FOREIGN KEY (distributor_product_id) REFERENCES distributor_products (id) NOT VALID;
  END IF;
END
$$;
