-- supabase/migrations/20260910000000_delete_price_histories_with_distributor_product.sql
-- release-order: db-first
--
-- WHY(2026-09-10、統合テストの後片付けを機械で測って見つけた): 契約 O-052 は
--      「代理店商品は admin + aal2 が `DELETE /api/distributor-products/[id]` で消せる」だが、
--      **仕切値を一度でも変えた商品は誰にも消せない**状態だった。
--
--      実測した中身:
--        - `price_histories_distributor_product_id_fkey` は `ON DELETE` 指定なし（NO ACTION）で
--          20260827000002 に入っている。履歴が 1 行あると DELETE が 23503 で止まる
--        - `price_histories` の GRANT は SELECT のみ（service_role でも DELETE できない）。
--          つまり**先に履歴を消してから商品を消す、という回避もできない**
--
--      同じ形は院内価格側で既に解いてある（20260906000007 が
--      `hospital_prices` の削除に合わせて履歴を消す）。親が消えたら履歴も消す、という
--      **同じ規則をもう一方の親（代理店商品）にも適用する**。
--
--      履歴だけ残しても `get_distributor_product_price_history` は親を join できず引けない
--      （＝孤児）。`hospital_prices` は既に `ON DELETE CASCADE` なので、
--      商品を消したときに施設の価格が消えるのは**この変更の前からそう**で、ここでは変えていない。
--
-- AFTER ではなく BEFORE にする理由: 院内価格側は price_histories からの FK が無いので
--      AFTER で足りたが、こちらは**実在の FK**があるため、行が消える前に参照を外す必要がある。
--
-- まだ決まっていないこと（人に聞く。docs/agents/design-questions.md の 4c に記録）:
--      「施設が使っている代理店商品を、admin がそもそも消せてよいか」。
--      消せる場合、`hospital_prices` の CASCADE で**全施設の仕入価格が一緒に消える**。
--      ここではその可否を変えていない（消せる前提のまま、消せない不整合だけを直した）。

-- SECURITY DEFINER について: これは**トリガー関数**で、クライアントロールに
--      `GRANT EXECUTE` していない（RPC として呼べる道は無い）。認可は親の削除そのものが担う——
--      `distributor_products` の DELETE ポリシー（admin + aal2）を通らなければトリガーは動かない。
--      DEFINER が要るのは `price_histories` の GRANT が SELECT のみだからで、
--      20260906000007（院内価格側）とまったく同じ理由・同じ形。
CREATE OR REPLACE FUNCTION delete_price_histories_with_distributor_product()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- WHY(2 つの列を両方見る): この表は entity_type/entity_id の緩い参照と
  --      distributor_product_id の実 FK を**両方**持つ。FK を外すだけでは
  --      entity_type='distributor_product' の孤児が残る（実データでは同じ ID が入る）。
  DELETE FROM public.price_histories
  WHERE distributor_product_id = OLD.id
     OR (entity_type = 'distributor_product' AND entity_id = OLD.id);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS distributor_products_delete_price_histories ON distributor_products;
CREATE TRIGGER distributor_products_delete_price_histories
  BEFORE DELETE ON distributor_products
  FOR EACH ROW EXECUTE FUNCTION delete_price_histories_with_distributor_product();

-- 既に孤児になっている履歴（親の distributor_products が無いもの）を掃除する。
-- WHY(掃除する): FK は NOT VALID で入っているので、20260827000002 より前に生まれた孤児が
--      残っている可能性がある。残しても誰も引けない（親が無いと join できない）。
DELETE FROM price_histories ph
WHERE ph.entity_type = 'distributor_product'
  AND NOT EXISTS (SELECT 1 FROM distributor_products dp WHERE dp.id = ph.entity_id);

-- ROLLBACK:
--   DROP TRIGGER distributor_products_delete_price_histories ON distributor_products;
--   DROP FUNCTION delete_price_histories_with_distributor_product();
--   （掃除した孤児行は戻せない。孤児は親が無いのでアプリからは元々引けない）
