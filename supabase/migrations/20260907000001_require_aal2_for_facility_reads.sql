-- supabase/migrations/20260907000001_require_aal2_for_facility_reads.sql
-- issue #757 の 39（乗っ取り後の被害限定、B-001）。約束カタログ P-034。
-- release-order: db-first
--
-- WHY: 20260806000002（#623）と 20260906000008（#757-39）で「書き込みには TOTP が要る」を揃えたが、
--      **読み取りは aal1 のまま全施設に届いていた**。blast-radius.integration.test.ts の B-001 が
--      「MFA 登録済み admin のパスワードだけで、所属していない施設の患者 ID まで読める」ことを
--      実測している。読み取りは audit_log にも残らないので、漏れても後から気づけない。
--
--      施設スコープの表と監査ログの SELECT に has_aal2() を足して、パスワード 1 つでは
--      患者情報に届かないようにする。
--
--      費用が小さいことは実測済み:
--        - has_aal2() は verified な TOTP factor を持たない利用者に TRUE を返すので、
--          MFA 未登録の利用者は影響を受けない（20260806000001 の定義。#623 と同じ設計）
--        - MFA 登録済みの利用者は proxy.ts が保護ページに入る前に aal2 へ昇格させる
--        - aal1 のまま描画される画面（/login・/mfa-challenge・layout.tsx）は
--          施設スコープの表を読まない（2026-09-07 実測）
--
--      permissive なポリシーは OR で合成される。SELECT 時は本ポリシーと
--      facility_writer_or_admin（FOR ALL、既に has_aal2() を持つ）の OR になるため、
--      本ポリシー側に has_aal2() を足せば SELECT 全体が aal2 を要求する。
--
-- 対象外（理由つき）:
--   - facilities の SELECT: 施設名だけで患者情報を含まない。施設の選択は aal2 昇格後の画面でしか使わない
--   - マスタ（products / categories / distributor_products / product_compatibilities）:
--     テナント非分離で SELECT が USING(true)。商品情報であって患者情報ではない
--   - price_histories と get_distributor_product_price_history: 価格の履歴。テナント非分離が設計
--     （20260622000000 / 20260718000001 の注記）。ここを締めるなら別の判断として行う
--   - get_news_feed: SECURITY DEFINER ではないので本 migration の RLS 変更がそのまま効く
--
-- ROLLBACK:
--   6 表の SELECT ポリシーを has_aal2() 無しに戻す:
--     DROP POLICY IF EXISTS "facility_member_or_admin" ON <table>;
--     CREATE POLICY "facility_member_or_admin" ON <table> FOR SELECT TO authenticated
--       USING (is_facility_member(facility_id) OR is_admin());
--   4 明細表は親経由の EXISTS を has_aal2() 無しに戻す（20260805000001 と同じ本文）。
--   audit_log は USING (is_admin() OR (facility_id IS NOT NULL AND is_facility_member(facility_id))) に戻す。
--   get_order_amount_report は 20260715000003 の本文（has_aal2() チェック無し）に戻す。

-- 1. 施設スコープの直接テーブル 6 本
DROP POLICY IF EXISTS "facility_member_or_admin" ON consumable_orders;
CREATE POLICY "facility_member_or_admin" ON consumable_orders
  FOR SELECT TO authenticated
  USING ((is_facility_member(facility_id) OR is_admin()) AND has_aal2());

DROP POLICY IF EXISTS "facility_member_or_admin" ON case_orders;
CREATE POLICY "facility_member_or_admin" ON case_orders
  FOR SELECT TO authenticated
  USING ((is_facility_member(facility_id) OR is_admin()) AND has_aal2());

DROP POLICY IF EXISTS "facility_member_or_admin" ON loan_orders;
CREATE POLICY "facility_member_or_admin" ON loan_orders
  FOR SELECT TO authenticated
  USING ((is_facility_member(facility_id) OR is_admin()) AND has_aal2());

DROP POLICY IF EXISTS "facility_member_or_admin" ON loan_returns;
CREATE POLICY "facility_member_or_admin" ON loan_returns
  FOR SELECT TO authenticated
  USING ((is_facility_member(facility_id) OR is_admin()) AND has_aal2());

DROP POLICY IF EXISTS "facility_member_or_admin" ON hospital_prices;
CREATE POLICY "facility_member_or_admin" ON hospital_prices
  FOR SELECT TO authenticated
  USING ((is_facility_member(facility_id) OR is_admin()) AND has_aal2());

DROP POLICY IF EXISTS "facility_member_or_admin" ON consumables;
CREATE POLICY "facility_member_or_admin" ON consumables
  FOR SELECT TO authenticated
  USING ((is_facility_member(facility_id) OR is_admin()) AND has_aal2());

-- 2. 明細テーブル 4 本（親 order 経由。患者に紐づく品目が入る）
DROP POLICY IF EXISTS "facility_member_or_admin" ON case_order_items;
CREATE POLICY "facility_member_or_admin" ON case_order_items
  FOR SELECT TO authenticated
  USING (has_aal2() AND EXISTS (
    SELECT 1 FROM case_orders o
    WHERE o.id = case_order_items.case_order_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ));

DROP POLICY IF EXISTS "facility_member_or_admin" ON consumable_order_items;
CREATE POLICY "facility_member_or_admin" ON consumable_order_items
  FOR SELECT TO authenticated
  USING (has_aal2() AND EXISTS (
    SELECT 1 FROM consumable_orders o
    WHERE o.id = consumable_order_items.consumable_order_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ));

DROP POLICY IF EXISTS "facility_member_or_admin" ON loan_order_items;
CREATE POLICY "facility_member_or_admin" ON loan_order_items
  FOR SELECT TO authenticated
  USING (has_aal2() AND EXISTS (
    SELECT 1 FROM loan_orders o
    WHERE o.id = loan_order_items.loan_order_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ));

DROP POLICY IF EXISTS "facility_member_or_admin" ON loan_return_items;
CREATE POLICY "facility_member_or_admin" ON loan_return_items
  FOR SELECT TO authenticated
  USING (has_aal2() AND EXISTS (
    SELECT 1 FROM loan_returns o
    WHERE o.id = loan_return_items.loan_return_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ));

-- 3. 監査ログ（old_data / new_data に患者情報が入る）
DROP POLICY IF EXISTS audit_log_select ON audit_log;
CREATE POLICY audit_log_select ON audit_log
  FOR SELECT TO authenticated
  USING ((is_admin() OR (facility_id IS NOT NULL AND is_facility_member(facility_id))) AND has_aal2());

-- 4. admin の集計 RPC（SECURITY DEFINER なので RLS を通らない。全施設の金額が出る）
--    本文は 20260715000003 のまま。has_aal2() チェックを 1 つ足しただけ。
--    CREATE OR REPLACE で引数の型が同じなので GRANT は維持される（DROP しない）。
CREATE OR REPLACE FUNCTION get_order_amount_report(
  p_date_from TIMESTAMPTZ,
  p_date_to TIMESTAMPTZ
)
RETURNS TABLE(
  facility_id UUID,
  facility_name TEXT,
  case_order_amount NUMERIC,
  case_order_count INTEGER,
  case_order_total_count INTEGER,
  consumable_order_amount NUMERIC,
  consumable_order_count INTEGER,
  consumable_order_total_count INTEGER,
  loan_order_amount NUMERIC,
  loan_order_count INTEGER,
  loan_order_total_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'permission denied';
  END IF;

  -- WHY(#757-39 B-001): SECURITY DEFINER は RLS を通らないため、テーブル側に has_aal2() を
  --      足しただけではこの RPC 経由で全施設の金額が aal1 のまま読めてしまう。
  --      admin 判定の後に置くのは P-032 と同じ理由（判定順で情報を漏らさない）。
  IF NOT has_aal2() THEN
    RAISE EXCEPTION 'forbidden: aal2 required';
  END IF;

  RETURN QUERY
  SELECT
    f.id AS facility_id,
    f.name AS facility_name,
    co_agg.amount AS case_order_amount,
    COALESCE(co_agg.cnt, 0)::INTEGER AS case_order_count,
    COALESCE(co_agg.total_cnt, 0)::INTEGER AS case_order_total_count,
    cons_agg.amount AS consumable_order_amount,
    COALESCE(cons_agg.cnt, 0)::INTEGER AS consumable_order_count,
    COALESCE(cons_agg.total_cnt, 0)::INTEGER AS consumable_order_total_count,
    loan_agg.amount AS loan_order_amount,
    COALESCE(loan_agg.cnt, 0)::INTEGER AS loan_order_count,
    COALESCE(loan_agg.total_cnt, 0)::INTEGER AS loan_order_total_count
  FROM facilities f
  LEFT JOIN (
    SELECT
      co.facility_id,
      SUM(coi.unit_price * coi.quantity) FILTER (WHERE coi.unit_price IS NOT NULL) AS amount,
      COUNT(*) FILTER (WHERE coi.unit_price IS NOT NULL) AS cnt,
      COUNT(*) AS total_cnt
    FROM case_orders co
    JOIN case_order_items coi ON coi.case_order_id = co.id
    WHERE (p_date_from IS NULL OR co.created_at >= p_date_from)
      AND (p_date_to IS NULL OR co.created_at <= p_date_to)
    GROUP BY co.facility_id
  ) co_agg ON co_agg.facility_id = f.id
  LEFT JOIN (
    SELECT
      cons.facility_id,
      SUM(coi.unit_price * coi.quantity) FILTER (WHERE coi.unit_price IS NOT NULL) AS amount,
      COUNT(*) FILTER (WHERE coi.unit_price IS NOT NULL) AS cnt,
      COUNT(*) AS total_cnt
    FROM consumable_orders cons
    JOIN consumable_order_items coi ON coi.consumable_order_id = cons.id
    WHERE (p_date_from IS NULL OR cons.created_at >= p_date_from)
      AND (p_date_to IS NULL OR cons.created_at <= p_date_to)
    GROUP BY cons.facility_id
  ) cons_agg ON cons_agg.facility_id = f.id
  LEFT JOIN (
    SELECT
      lo.facility_id,
      SUM(loi.unit_price * loi.quantity) FILTER (WHERE loi.unit_price IS NOT NULL) AS amount,
      COUNT(*) FILTER (WHERE loi.unit_price IS NOT NULL) AS cnt,
      COUNT(*) AS total_cnt
    FROM loan_orders lo
    JOIN loan_order_items loi ON loi.loan_order_id = lo.id
    WHERE (p_date_from IS NULL OR lo.created_at >= p_date_from)
      AND (p_date_to IS NULL OR lo.created_at <= p_date_to)
    GROUP BY lo.facility_id
  ) loan_agg ON loan_agg.facility_id = f.id
  ORDER BY f.name;
END;
$$;
