-- supabase/migrations/20260715000003_add_order_amount_report_rpc.sql
-- issue #23 Part2 Set B: 施設別×発注種別の発注金額集計RPC。
-- WHY: adminのみが全施設の金額を横断集計できるようにするため、SECURITY DEFINER +
--      is_admin()チェックで実装する（既存admin-auth.tsパターンを踏襲）。
--
-- WHY(*_total_count列): 当初案では*_count(単価データがある明細の件数)がゼロの場合、
--   「発注自体が0件」なのか「発注はあるが全明細のunit_priceがNULL(金額データなし)」なのかを
--   区別できず、UI側で両者を誤って同一視してしまうcriticalなバグがあった(コードレビュー指摘)。
--   *_total_count(価格の有無を問わない全明細件数)を追加で返し、
--     total_count = 0            → 発注自体が0件
--     total_count > 0 かつ amount IS NULL → 発注はあるが金額データなし
--   をUI側(ReportTable)で区別できるようにする。

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

-- anonは除外し、実行時の最終ガードは関数内is_admin()に委ねる。
GRANT EXECUTE ON FUNCTION get_order_amount_report(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

-- 新規テーブルの追加/削除を伴わない（RPC新設のみ）ため refresh_schema_baseline_snapshot は不要。
