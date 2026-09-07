-- supabase/migrations/20260907000006_add_denial_anomaly_check.sql
-- issue #757 の 8（安全性のモニタリング・カナリア）。拒否の記録（20260907000002）を毎晩数え、
-- 「同じ人が短時間に何度も弾かれている」並びを異常として記録し、issue にする。
-- release-order: db-first
-- lock: 既存の表は schema_drift_log の CHECK 制約を張り替えるだけ。行の書き換えは無い。
--
-- design: 2026-09-07 に人へ聞いて決めた答え（docs/agents/design-questions.md）。
--   量: 同じ人が **1 時間に 20 回** 拒否されたら異常。正しく使っている人はまず 1 回も出さない。
--       画面の操作ミスや期限切れセッションの連続失敗は許し、他施設 ID の総当たりは拾う値。
--   超えたとき: 記録して issue を立てる（黙って捨てない）。スキーマドリフト検知と同じ経路に載せる。
--   大きさ: 新しい表は作らない。schema_drift_log に drift_type='denial_anomaly' で入れる。
--   権限: 実行できるのは service_role だけ。client には EXECUTE を渡さない。
--   消えるとき: 直近 1 時間に閾値を下回れば自動で resolved になり、issue も自動で閉じる。
--   記録: 誰が・どの境界で・何回かを detail に残す。actor_id が null の拒否（未認証）は
--         人を特定できないので guard ごとにまとめて数える。
--   途中で止まったら: 数えるだけで副作用が無い。失敗しても拒否そのものには影響しない。
--   外に出るもの: **利用者の ID は外に出さない**。schema_drift_log の object_name は
--                 drift_alert_view（anon キーで読める）を通って GitHub issue のタイトルになるため、
--                 ここに actor_id を書くと「誰が弾かれたか」が公開値で読めてしまう。
--                 object_name は actor_id の伏せ字（md5 の先頭 12 桁）にし、実際の ID は
--                 detail（view に出さない列）にだけ置く。対応付けは resolve_denial_anomaly_subject()
--                 が aal2 の admin にだけ返す。
--
-- WHY(新しい仕組みを作らない): 「毎晩数えて、開いている限り issue が立っている」経路は
--      スキーマドリフト検知（#305）と不変条件の夜間検査（#757-9）で既に動いている。
--      検知だけを足して同じレールに載せる方が、動いていないことに気づける。
--
-- WHY(1 時間の窓を毎晩見る): 実行は日次だが、数えるのは **直近 24 時間の中で最も混んだ 1 時間**。
--      日次の合計にすると、1 時間に集中した総当たりが 1 日の中で薄まって見えなくなる。

-- 1. drift_type に denial_anomaly を追加
ALTER TABLE schema_drift_log DROP CONSTRAINT schema_drift_log_drift_type_check;
ALTER TABLE schema_drift_log
  ADD CONSTRAINT schema_drift_log_drift_type_check
  CHECK (drift_type IN ('rls_disabled', 'table_added', 'table_removed', 'invariant_violation', 'denial_anomaly'));

-- 2. 検知（副作用なし）
--    p_threshold / p_window_seconds を引数にしているのは、テストが小さい値で実演できるようにするため。
--    既定値は人が決めた値（1 時間に 20 回）。
CREATE OR REPLACE FUNCTION check_denial_anomalies(
  p_threshold INTEGER DEFAULT 20,
  p_window_seconds INTEGER DEFAULT 3600,
  p_lookback_seconds INTEGER DEFAULT 86400
)
RETURNS TABLE (subject TEXT, hits BIGINT, detail JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_threshold < 1 OR p_window_seconds < 1 OR p_lookback_seconds < 1 THEN
    RAISE EXCEPTION 'thresholds must be >= 1';
  END IF;

  -- WHY: 拒否 1 件ごとに「その時刻から窓の幅だけ遡った件数」を数える（滑走窓）。
  --      固定窓だと境目をまたいだ総当たりを取り逃がす。件数は多くないので窓関数で足りる。
  RETURN QUERY
  WITH recent AS (
    SELECT
      -- WHY: 伏せ字にするのは object_name が anon キーで読めるため（上の design 参照）。
      --      md5 は暗号強度のためではなく「同じ人なら同じ印」を作るためだけに使う。
      --      未認証の拒否は人を特定できないので guard ごとにまとめる。
      CASE
        WHEN d.actor_id IS NULL THEN 'anonymous:' || d.guard
        ELSE 'user:' || left(md5(d.actor_id::TEXT), 12)
      END AS subject,
      d.actor_id,
      d.guard,
      d.reason,
      d.occurred_at
    FROM access_denials d
    WHERE d.occurred_at >= now() - make_interval(secs => p_lookback_seconds)
  ), windowed AS (
    SELECT
      r.subject,
      r.occurred_at,
      count(*) OVER (
        PARTITION BY r.subject
        ORDER BY r.occurred_at
        RANGE BETWEEN make_interval(secs => p_window_seconds) PRECEDING AND CURRENT ROW
      ) AS hits_in_window
    FROM recent r
  ), peak AS (
    SELECT w.subject, max(w.hits_in_window) AS hits
    FROM windowed w
    GROUP BY w.subject
    HAVING max(w.hits_in_window) >= p_threshold
  )
  SELECT
    p.subject,
    p.hits,
    jsonb_build_object(
      'hits', p.hits,
      'threshold', p_threshold,
      'window_seconds', p_window_seconds,
      'guards', (
        SELECT jsonb_object_agg(g.guard, g.n)
        FROM (
          SELECT r.guard, count(*) AS n
          FROM recent r
          WHERE r.subject = p.subject
          GROUP BY r.guard
        ) g
      ),
      'reasons', (
        SELECT jsonb_object_agg(x.reason, x.n)
        FROM (
          SELECT r.reason, count(*) AS n
          FROM recent r
          WHERE r.subject = p.subject
          GROUP BY r.reason
        ) x
      ),
      'last_seen', (SELECT max(r.occurred_at) FROM recent r WHERE r.subject = p.subject),
      -- WHY: 実際の利用者 ID はここにだけ置く。detail は drift_alert_view に出ない
      'actor_id', (SELECT max(r.actor_id::TEXT) FROM recent r WHERE r.subject = p.subject)
    )
  FROM peak p;
END;
$$;

-- 3. 記録（冪等 INSERT と自動 resolved。record_business_invariants と同じ型）
CREATE OR REPLACE FUNCTION record_denial_anomalies(
  p_threshold INTEGER DEFAULT 20,
  p_window_seconds INTEGER DEFAULT 3600,
  p_lookback_seconds INTEGER DEFAULT 86400
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _current_denial_anomalies ON COMMIT DROP AS
  SELECT subject AS object_name, detail
  FROM check_denial_anomalies(p_threshold, p_window_seconds, p_lookback_seconds);

  INSERT INTO schema_drift_log (drift_type, object_name, detail)
  SELECT 'denial_anomaly', a.object_name, a.detail FROM _current_denial_anomalies a
  ON CONFLICT (drift_type, object_name) WHERE resolved_at IS NULL DO NOTHING;

  -- WHY: 収まったら自動で閉じる。閾値を下回った人は _current に出てこない
  UPDATE schema_drift_log l
  SET event_kind = 'resolved', resolved_at = now()
  WHERE l.drift_type = 'denial_anomaly'
    AND l.event_kind = 'detected' AND l.resolved_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM _current_denial_anomalies a WHERE a.object_name = l.object_name);
END;
$$;

-- 4. 伏せ字から実際の利用者 ID を引く（調査する人のための唯一の窓口）
-- WHY(SECURITY DEFINER + 明示の認可): schema_drift_log は service_role しか読めないので、
--      調査する admin のために関数を 1 つだけ開ける。RLS を迂回する代わりに、
--      関数の中で admin かつ aal2 を確認する（access_denials の読み取りと同じ条件に揃える）。
CREATE OR REPLACE FUNCTION resolve_denial_anomaly_subject(p_object_name TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor TEXT;
BEGIN
  IF NOT (public.is_admin() AND public.has_aal2()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT l.detail ->> 'actor_id' INTO v_actor
  FROM public.schema_drift_log l
  WHERE l.drift_type = 'denial_anomaly' AND l.object_name = p_object_name
  ORDER BY l.detected_at DESC
  LIMIT 1;

  RETURN v_actor::UUID;
END;
$$;

REVOKE ALL ON FUNCTION resolve_denial_anomaly_subject(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION resolve_denial_anomaly_subject(TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION resolve_denial_anomaly_subject(TEXT) IS
  '拒否の異常の伏せ字（user:xxxxxxxxxxxx）から実際の利用者 ID を返す。aal2 の admin のみ（issue #757 の 8）';

-- 5. 拒否の記録を時刻で引けるようにする（毎晩の走査が全件走らないように）
CREATE INDEX IF NOT EXISTS idx_access_denials_occurred_at_actor
  ON access_denials (occurred_at DESC, actor_id);

-- 6. 権限: service_role だけ（Supabase 既定権限を 3 ロールとも外す）
REVOKE ALL ON FUNCTION check_denial_anomalies(INTEGER, INTEGER, INTEGER)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION record_denial_anomalies(INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION check_denial_anomalies(INTEGER, INTEGER, INTEGER)  TO service_role;
GRANT EXECUTE ON FUNCTION record_denial_anomalies(INTEGER, INTEGER, INTEGER) TO service_role;

COMMENT ON FUNCTION check_denial_anomalies(INTEGER, INTEGER, INTEGER) IS
  '拒否の記録から「同じ人が窓の中で閾値以上」を返す（issue #757 の 8）。既定は 1 時間に 20 回。service_role のみ';

-- 7. 日次実行。UTC 22:40 = JST 7:40（不変条件 22:50・drift 23:00・Actions 0:00 より前）
SELECT cron.schedule(
  'denial-anomaly-daily-check',
  '40 22 * * *',
  $$ SELECT record_denial_anomalies(); $$
);

-- ROLLBACK:
--   SELECT cron.unschedule('denial-anomaly-daily-check');
--   DROP FUNCTION record_denial_anomalies(INTEGER, INTEGER, INTEGER);
--   DROP FUNCTION check_denial_anomalies(INTEGER, INTEGER, INTEGER);
--   DROP FUNCTION resolve_denial_anomaly_subject(TEXT);
--   DROP INDEX idx_access_denials_occurred_at_actor;
--   drift_type の CHECK を 4 値に戻す（denial_anomaly の行を先に消す）

-- テーブル新設/削除ではないため refresh_schema_baseline_snapshot は不要
