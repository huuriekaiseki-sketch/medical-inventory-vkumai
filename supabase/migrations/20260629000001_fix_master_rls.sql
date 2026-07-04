-- supabase/migrations/20260629000001_fix_master_rls.sql
-- WHY: products / categories / distributor_products は「全認証ユーザーが参照可、
--      書き込み(INSERT/UPDATE/DELETE)は admin のみ」という設計意図(SPEC-tech-debt.md SET F)を
--      RLSに反映する。既存の "auth_only" FOR ALL ポリシーは書き込みも全認証ユーザーに
--      許可しており設計意図と一致しないため、SELECT用ポリシーとCUD用ポリシーに分割する。

-- =========================================================================
-- products
-- =========================================================================
DROP POLICY IF EXISTS "auth_only" ON products;
CREATE POLICY "products_select" ON products FOR SELECT TO authenticated USING (true);
CREATE POLICY "products_write" ON products FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- =========================================================================
-- categories
-- =========================================================================
DROP POLICY IF EXISTS "auth_only" ON categories;
CREATE POLICY "categories_select" ON categories FOR SELECT TO authenticated USING (true);
CREATE POLICY "categories_write" ON categories FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- =========================================================================
-- distributor_products
-- =========================================================================
DROP POLICY IF EXISTS "auth_only" ON distributor_products;
CREATE POLICY "distributor_products_select" ON distributor_products FOR SELECT TO authenticated USING (true);
CREATE POLICY "distributor_products_write" ON distributor_products FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
