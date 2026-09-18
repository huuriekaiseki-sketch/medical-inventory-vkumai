-- supabase/migrations/20260906000007_delete_price_histories_with_hospital_price.sql
-- WHY: issue #757 の 12（データの保持と削除）のうち I-052「施設を削除すると、その施設の発注・返却・
--      価格・所属が残らない」。施設への FK はすべて ON DELETE CASCADE で、明細も親から CASCADE する。
--      唯一の例外が price_histories: hospital_prices への FK を持たず entity_id で緩く参照するため、
--      施設（→ hospital_prices）を消しても「施設ごとの仕入価格の変更履歴」が孤児として残っていた。
--      RLS は親 hospital_prices の施設で判定するので client からは見えなくなるが、DB には残る
--      （退会した施設の価格情報の残存。#757-28 の「どこに何が残るか」の DB 側）。
--      hospital_prices の削除に合わせて、その行の履歴を消すトリガーを足す。
--      監査ログ（audit_log）は意図的に FK を張らず残す（削除の証跡。20260906000004）。
--      price_histories は GRANT が SELECT のみで client からは消せないため、トリガーは
--      SECURITY DEFINER（表の所有者として実行）で消す。

CREATE OR REPLACE FUNCTION delete_price_histories_with_hospital_price()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.price_histories
  WHERE entity_type = 'hospital_price' AND entity_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER hospital_prices_delete_price_histories
  AFTER DELETE ON hospital_prices
  FOR EACH ROW EXECUTE FUNCTION delete_price_histories_with_hospital_price();

-- 既に孤児になっている履歴（親の hospital_prices が無いもの）を掃除する
DELETE FROM price_histories ph
WHERE ph.entity_type = 'hospital_price'
  AND NOT EXISTS (SELECT 1 FROM hospital_prices hp WHERE hp.id = ph.entity_id);

-- ROLLBACK:
--   DROP TRIGGER hospital_prices_delete_price_histories ON hospital_prices;
--   DROP FUNCTION delete_price_histories_with_hospital_price();
--   （掃除した孤児行は戻せない。監査ログには残る）
