-- supabase/migrations/20260906000008_require_aal2_for_master_writes.sql
-- issue #757 の 39（内部不正・乗っ取り後の被害限定）。約束カタログ P-033。
-- release-order: db-first
--
-- WHY: 20260806000002（issue #623）は施設スコープの表の書き込みに has_aal2() を足したが、
--      マスタ 4 表（products / categories / distributor_products / product_compatibilities）の
--      書き込みポリシーは is_admin() だけのまま残っていた。実測（blast-radius.integration.test.ts）で、
--      MFA 登録済み admin の**パスワードだけ**を持つ攻撃者（aal1 セッション）が
--      products を UPDATE / DELETE できることを確認した。
--      products の削除は distributor_products → hospital_prices へ ON DELETE CASCADE で波及し、
--      全施設の仕入価格が消える。「TOTP を持っていないと業務データは書けない」という
--      #623 の約束と揃え、マスタも aal2 を要求する。
--
--      has_aal2() は「verified な TOTP factor を持たない利用者には TRUE」を返すため、
--      MFA 未登録の admin の運用は変わらない（#623 と同じ設計）。
--
-- 影響: 画面経由の admin は proxy.ts が aal2 まで昇格させてから通すので変更不要（アプリ側の変更なし）。
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS "products_write" ON products;
--   CREATE POLICY "products_write" ON products FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
--   DROP POLICY IF EXISTS "categories_write" ON categories;
--   CREATE POLICY "categories_write" ON categories FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
--   DROP POLICY IF EXISTS "distributor_products_write" ON distributor_products;
--   CREATE POLICY "distributor_products_write" ON distributor_products FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
--   DROP POLICY IF EXISTS "compat_write" ON product_compatibilities;
--   CREATE POLICY "compat_write" ON product_compatibilities FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "products_write" ON products;
CREATE POLICY "products_write" ON products
  FOR ALL TO authenticated
  USING (is_admin() AND has_aal2())
  WITH CHECK (is_admin() AND has_aal2());

DROP POLICY IF EXISTS "categories_write" ON categories;
CREATE POLICY "categories_write" ON categories
  FOR ALL TO authenticated
  USING (is_admin() AND has_aal2())
  WITH CHECK (is_admin() AND has_aal2());

DROP POLICY IF EXISTS "distributor_products_write" ON distributor_products;
CREATE POLICY "distributor_products_write" ON distributor_products
  FOR ALL TO authenticated
  USING (is_admin() AND has_aal2())
  WITH CHECK (is_admin() AND has_aal2());

DROP POLICY IF EXISTS "compat_write" ON product_compatibilities;
CREATE POLICY "compat_write" ON product_compatibilities
  FOR ALL TO authenticated
  USING (is_admin() AND has_aal2())
  WITH CHECK (is_admin() AND has_aal2());

-- WHY: facilities は INSERT が admin_insert（is_admin() のみ）、UPDATE が
--      facility_writer_or_admin_update。20260806000002 が「施設名の更新は aal2 の対象外」と
--      明示的に決めた（#623）ので UPDATE はそのままにし、新規作成だけ aal2 を要求する
--      （施設を増やす操作はテナントを増やす操作で、乗っ取り時の被害が大きいため）。
DROP POLICY IF EXISTS "admin_insert" ON facilities;
CREATE POLICY "admin_insert" ON facilities
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() AND has_aal2());
