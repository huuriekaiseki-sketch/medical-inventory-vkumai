-- supabase/migrations/20260906000005_add_nightly_invariant_check.sql
-- issue #757 の 9（不変条件の夜間検査）。不変条件カタログ I-050 / I-051 の守る場所。
--
-- WHY: 集計をまたぐ不変条件（返却数量 ≤ 貸出数量）は CHECK にできず、NOT VALID で入れた CHECK は
--      既存行を検査していない。どちらも「毎晩 SELECT して違反を数える」でしか守れない。
--      検知・記録・issue 化の経路はスキーマドリフト検知（issue #305）と同じ型を使い回す:
--        DB 側: pg_cron が record_business_invariants() を日次で呼び、schema_drift_log に
--               drift_type = 'invariant_violation' として冪等 INSERT / 自動 resolved
--        GitHub 側: schema-drift-check.yml が drift_alert_view を読んで issue を作成 / クローズ
--      新しいテーブル・ワークフローを増やさず、同じ「未解決なら issue が開いている」運用に乗せる。
--
-- I-050: loan_order_id で紐づく返却明細の数量合計が、貸出明細の数量合計を JAN ごとに超えていない
-- I-051: NOT VALID の CHECK 制約に違反する既存行が 0 件（pg_constraint から動的に列挙するので、
--        制約を足すたびにここを直す必要は無い。0 件を確認したら別 migration で VALIDATE CONSTRAINT）

-- 1. drift_type に invariant_violation を追加
ALTER TABLE schema_drift_log DROP CONSTRAINT schema_drift_log_drift_type_check;
ALTER TABLE schema_drift_log
  ADD CONSTRAINT schema_drift_log_drift_type_check
  CHECK (drift_type IN ('rls_disabled', 'table_added', 'table_removed', 'invariant_violation'));

-- 2. 検知（副作用なし）
CREATE OR REPLACE FUNCTION check_business_invariants()
RETURNS TABLE (invariant_id TEXT, object_name TEXT, detail JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r       RECORD;
  v_expr  TEXT;
  v_count BIGINT;
BEGIN
  -- I-050
  RETURN QUERY
  WITH returned AS (
    SELECT lr.loan_order_id, lri.jan, SUM(lri.quantity) AS qty
    FROM loan_returns lr
    JOIN loan_return_items lri ON lri.loan_return_id = lr.id
    WHERE lr.loan_order_id IS NOT NULL
    GROUP BY lr.loan_order_id, lri.jan
  ), loaned AS (
    SELECT loi.loan_order_id, loi.jan, SUM(loi.quantity) AS qty
    FROM loan_order_items loi
    GROUP BY loi.loan_order_id, loi.jan
  )
  SELECT 'I-050'::TEXT,
         rt.loan_order_id::TEXT || ':' || rt.jan,
         jsonb_build_object('jan', rt.jan, 'returned', rt.qty, 'loaned', COALESCE(ln.qty, 0))
  FROM returned rt
  LEFT JOIN loaned ln ON ln.loan_order_id = rt.loan_order_id AND ln.jan IS NOT DISTINCT FROM rt.jan
  WHERE rt.qty > COALESCE(ln.qty, 0);

  -- I-051
  FOR r IN
    SELECT c.conname, t.relname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'c' AND NOT c.convalidated AND n.nspname = 'public'
  LOOP
    -- pg_get_constraintdef は 'CHECK ((expr)) NOT VALID' を返す。式だけを取り出して NOT (式) で数える
    -- （式が NULL になる行は CHECK を通るので、NOT (NULL) = NULL で数えない = 正しい）
    v_expr := substring(r.def FROM '^CHECK \((.*)\) NOT VALID$');
    IF v_expr IS NULL THEN CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE NOT (%s)', r.relname, v_expr) INTO v_count;
    IF v_count > 0 THEN
      invariant_id := 'I-051';
      object_name  := r.conname;
      detail       := jsonb_build_object('table', r.relname, 'count', v_count);
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

-- 3. 記録（冪等 INSERT と自動 resolved。record_schema_drift と同じ型）
CREATE OR REPLACE FUNCTION record_business_invariants()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _current_invariants ON COMMIT DROP AS
  SELECT invariant_id || ':' || object_name AS object_name, detail FROM check_business_invariants();

  INSERT INTO schema_drift_log (drift_type, object_name, detail)
  SELECT 'invariant_violation', i.object_name, i.detail FROM _current_invariants i
  ON CONFLICT (drift_type, object_name) WHERE resolved_at IS NULL DO NOTHING;

  UPDATE schema_drift_log l
  SET event_kind = 'resolved', resolved_at = now()
  WHERE l.drift_type = 'invariant_violation'
    AND l.event_kind = 'detected' AND l.resolved_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM _current_invariants i WHERE i.object_name = l.object_name);
END;
$$;

-- 4. record_schema_drift の自動 resolved を自分の種別に限定する
--    （従来は「現在の drift に無い detected 行」を全部 resolved にしていたので、
--      invariant_violation の行を毎晩 resolved にしてしまう）
CREATE OR REPLACE FUNCTION record_schema_drift()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _current_schema_drift ON COMMIT DROP AS
  SELECT * FROM check_schema_drift();

  INSERT INTO schema_drift_log (drift_type, object_name, detail)
  SELECT d.drift_type, d.object_name, d.detail FROM _current_schema_drift d
  ON CONFLICT (drift_type, object_name) WHERE resolved_at IS NULL DO NOTHING;

  UPDATE schema_drift_log l
  SET event_kind = 'resolved', resolved_at = now()
  WHERE l.drift_type IN ('rls_disabled', 'table_added', 'table_removed')
    AND l.event_kind = 'detected' AND l.resolved_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM _current_schema_drift d
      WHERE d.drift_type = l.drift_type AND d.object_name = l.object_name
    );
END;
$$;

-- 5. 権限: service_role だけ（Supabase 既定権限を 3 ロールとも外す。known-failure-patterns 参照）
REVOKE ALL ON FUNCTION check_business_invariants()  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION record_business_invariants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION check_business_invariants()  TO service_role;
GRANT EXECUTE ON FUNCTION record_business_invariants() TO service_role;

-- 6. 日次実行。UTC 22:50 = JST 7:50。schema drift（23:00）と GitHub Actions（0:00）より前
SELECT cron.schedule(
  'business-invariants-daily-check',
  '50 22 * * *',
  $$ SELECT record_business_invariants(); $$
);

-- ROLLBACK:
--   SELECT cron.unschedule('business-invariants-daily-check');
--   DROP FUNCTION record_business_invariants(); DROP FUNCTION check_business_invariants();
--   record_schema_drift() を 20260714000003 の定義に戻す
--   drift_type の CHECK を 3 値に戻す（invariant_violation の行を先に消す）

-- テーブル新設/削除ではないため refresh_schema_baseline_snapshot は不要
