-- supabase/migrations/20260908070000_allow_cancelling_orders.sql
-- release-order: db-first
-- design: 権限=施設の writer（発注を作れる人が直せる人。RLS は既存の facility_writer_or_admin のまま）／
--         大きさ・量は変えない／消えるとき=**行は消さない**（取り消し状態にする。証跡を残す）／
--         記録=既存の監査トリガーが status の変更を残す／外部送信なし
-- lock: 既存 CHECK の張り替えと関数の再定義のみ。ALTER TABLE ... DROP/ADD CONSTRAINT は
--       ACCESS EXCLUSIVE を取り、ADD 側は既存行を全件検証する。手元の DB で実測した行数は
--       case_orders 4 / consumable_orders 0 / loan_orders 4（作り直した直後）。
--       本番で桁違いなら NOT VALID → VALIDATE の 2 段に分ける
-- cardinality: many
--
-- WHY(E-056 の残り): 2026-09-08 に**返却**の取り消しを作った（20260908060000）が、
--      **発注 3 種は手つかず**のままだった。同じ穴で、間違えて登録した発注を製品の中で直せない。
--      同日の判断で作成＝確定（E-052）にしたので、押した瞬間に確定する。
--
--      放置すると:
--        - 短貸発注: 誤った発注が**永久に「未返却」**として残る（返す物が無いので返却もできない）
--        - 症例・消耗品発注: 誤った金額が**集計に載り続ける**（/admin/reports の月次が狂う）
--
-- WHY(削除ではなく取り消し状態): 返却と同じ判断（2026-09-08、人が決定）。
--      行を残せば一覧に「取り消し済」と見え、status の変更として監査ログにも残る。
--
-- 変えるのは 2 か所:
--   1) 3 表の状態の語彙に cancelled を足す（状態遷移のトリガーは 20260908060000 で
--      「cancelled へはいつでも／cancelled からは戻れない」に対応済み。**関数は触らない**）
--   2) 発注金額の集計から取り消した発注を除く
--
-- WHY(未返却の側は触らない): `loan_outstanding_count()` も `orders/repository.ts` の
--      バッジも `status = 'submitted'` を条件にしているので、cancelled は**自動的に外れる**。
--      触ると条件が二重になって、かえって食い違いの種になる（E-053）。
--
-- ROLLBACK:
--   UPDATE case_orders SET status = 'submitted' WHERE status = 'cancelled';（他 2 表も同様）
--   ALTER TABLE case_orders DROP CONSTRAINT case_orders_status_check;
--   ALTER TABLE case_orders ADD CONSTRAINT case_orders_status_check
--     CHECK (status IN ('draft', 'submitted'));（他 2 表も同様）
--   （get_order_amount_report は 20260715000003 の定義に戻す）

-- =========================================================================
-- 1) 状態の語彙（I-021）
-- =========================================================================
ALTER TABLE case_orders DROP CONSTRAINT IF EXISTS case_orders_status_check;
ALTER TABLE case_orders
  ADD CONSTRAINT case_orders_status_check CHECK (status IN ('draft', 'submitted', 'cancelled'));

ALTER TABLE consumable_orders DROP CONSTRAINT IF EXISTS consumable_orders_status_check;
ALTER TABLE consumable_orders
  ADD CONSTRAINT consumable_orders_status_check CHECK (status IN ('draft', 'submitted', 'cancelled'));

ALTER TABLE loan_orders DROP CONSTRAINT IF EXISTS loan_orders_status_check;
ALTER TABLE loan_orders
  ADD CONSTRAINT loan_orders_status_check CHECK (status IN ('draft', 'submitted', 'cancelled'));

-- =========================================================================
-- 2) 発注金額の集計から取り消した発注を除く
--
-- WHY: 集計はこれまで状態を一切見ていなかった（draft も submitted も同じに数えていた）。
--      ここで `<> 'cancelled'` だけを足す。**draft を除く判断は別の話**なので混ぜない
--      （作成＝確定にした今、draft は新規には作られない）。
--
-- WHY(aal2 の判定を必ず残す): この関数は 20260715000003 で作られ、**20260907000001 で
--      `has_aal2()` の判定を足してある**（#757-39 B-001。SECURITY DEFINER は RLS を通らないので、
--      テーブル側に has_aal2() を足しただけでは aal1 のまま全施設の金額が読めてしまう）。
--      `CREATE OR REPLACE` は本文をまるごと差し替えるので、**古い版を元に書くと強化が消える**。
--      実際にこの migration の初稿でそれをやり、`blast-radius` の B-001 が落ちて気づいた。
--      **元にするのは「最後に定義した版」**（20260907000001）であって、最初の版ではない。
-- =========================================================================
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

  -- WHY(#757-39 B-001、20260907000001 から引き継ぐ): SECURITY DEFINER は RLS を通らないため、
  --      テーブル側に has_aal2() を足しただけではこの RPC 経由で全施設の金額が aal1 のまま
  --      読めてしまう。admin 判定の後に置くのは P-032 と同じ理由（判定順で情報を漏らさない）。
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
    WHERE co.status <> 'cancelled'
      AND (p_date_from IS NULL OR co.created_at >= p_date_from)
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
    WHERE cons.status <> 'cancelled'
      AND (p_date_from IS NULL OR cons.created_at >= p_date_from)
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
    WHERE lo.status <> 'cancelled'
      AND (p_date_from IS NULL OR lo.created_at >= p_date_from)
      AND (p_date_to IS NULL OR lo.created_at <= p_date_to)
    GROUP BY lo.facility_id
  ) loan_agg ON loan_agg.facility_id = f.id
  ORDER BY f.name;
END;
$$;

-- テーブルの新設・削除ではないため refresh_schema_baseline_snapshot の呼び出しは不要。
