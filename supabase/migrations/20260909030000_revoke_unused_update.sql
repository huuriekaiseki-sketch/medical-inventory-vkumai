-- supabase/migrations/20260909030000_revoke_unused_update.sql
-- release-order: db-first
-- design: 権限=**使っていない UPDATE を 4 表から外す**（明細 3 表と互換の組。2026-09-09）／
--         大きさ・量は変えない／消えるとき=変えない／記録=既存の監査トリガーのまま／外部送信なし
-- cardinality: many
--
-- WHY(20260909020000 の続き): 「DB は書けるのにアプリに道が無い」組み合わせは、DELETE を
--      剥がした時点で 12 件残っていた。そのうち **4 件は UPDATE** で、アプリは 1 か所も
--      これらの表を書き換えない。使っていない権限は到達範囲を広げるだけなので剥がす。
--
--   - `case_order_items` / `consumable_order_items` / `loan_order_items`
--     明細は作り直さない。間違えたら**発注ごと取り消して入れ直す**（E-056 の判断）。
--     数量や単価を後から書き換える道は作らない（`loan_order_items` は返却の残数がこの行を
--     見ているので、書き換わると未返却の計算が静かに狂う）。
--   - `product_compatibilities`
--     互換の組は**作るか消すかだけ**。付け替えは消して作り直す。
--
-- 対象外: `loan_return_items` の UPDATE は品目ごとの取り消し（status）で使っている。
--      発注 3 種・返却の UPDATE も取り消しで使っている。
--
-- WHY(ポリシーもコマンド別に割る): 権限だけ剥がすと「**ポリシーはあるのに権限が無い**」状態になり、
--      書いたポリシーが一度も評価されない（`scan-rls-grant-gaps.mjs` が検知する形）。
--      明細 3 表は 20260909020000 で INSERT / UPDATE の 2 本に割ってあるので UPDATE 用を落とすだけ。
--      `product_compatibilities` は `compat_write` が `FOR ALL` なので INSERT / DELETE に割る。
--
-- WHY(条件は最後に定義した版から写す・E-064): `compat_write` の条件は 20260906000008 の
--      `is_admin() AND has_aal2()` をそのまま写している（1 文字も変えていない）。
--
-- ROLLBACK:
--   -- 明細 3 表（<t> と <親> は下記と同じ）
--   CREATE POLICY "facility_writer_or_admin_update" ON <t> FOR UPDATE TO authenticated
--     USING (<20260909020000 と同じ条件>) WITH CHECK (<同じ条件>);
--   GRANT UPDATE ON TABLE <t> TO authenticated;
--   -- 互換の組
--   DROP POLICY IF EXISTS "compat_write_insert" ON product_compatibilities;
--   DROP POLICY IF EXISTS "compat_write_delete" ON product_compatibilities;
--   CREATE POLICY "compat_write" ON product_compatibilities FOR ALL TO authenticated
--     USING (is_admin() AND has_aal2()) WITH CHECK (is_admin() AND has_aal2());
--   GRANT UPDATE ON TABLE product_compatibilities TO authenticated;

-- =========================================================================
-- 1) 明細 3 表（作ったら書き換えない）
-- =========================================================================
DROP POLICY IF EXISTS "facility_writer_or_admin_update" ON case_order_items;
REVOKE UPDATE ON TABLE case_order_items FROM authenticated;

DROP POLICY IF EXISTS "facility_writer_or_admin_update" ON consumable_order_items;
REVOKE UPDATE ON TABLE consumable_order_items FROM authenticated;

DROP POLICY IF EXISTS "facility_writer_or_admin_update" ON loan_order_items;
REVOKE UPDATE ON TABLE loan_order_items FROM authenticated;

-- =========================================================================
-- 2) 互換の組（作るか消すかだけ）
-- =========================================================================
DROP POLICY IF EXISTS "compat_write" ON product_compatibilities;
CREATE POLICY "compat_write_insert" ON product_compatibilities
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() AND has_aal2());
CREATE POLICY "compat_write_delete" ON product_compatibilities
  FOR DELETE TO authenticated
  USING (is_admin() AND has_aal2());
REVOKE UPDATE ON TABLE product_compatibilities FROM authenticated;

-- テーブルの新設・削除ではないため refresh_schema_baseline_snapshot の呼び出しは不要。
