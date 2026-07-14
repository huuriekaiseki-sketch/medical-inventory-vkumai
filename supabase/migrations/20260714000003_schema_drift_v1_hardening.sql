-- WHY: 4観点並列レビュー（issue #305 Phase 5）で判明した構造的バグの是正。
--
-- 1. [critical] schema_baseline_snapshots を更新する手段が20260714000001時点では
--    存在せず、以後の「正規のPRレビュー済みmigration」でpublicテーブルを追加/削除
--    すると、baselineとの差分が二度と解消されない恒久的な誤検知になっていた
--    （table_added/table_removedが永遠にドリフト扱いされ続け、GitHub Issueが
--    自動クローズされない）。refresh_schema_baseline_snapshot()を追加し、
--    今後publicスキーマのテーブル構成を変えるmigrationは、その末尾で
--    `SELECT refresh_schema_baseline_snapshot('<このmigrationのタイムスタンプ>');`
--    を呼ぶ運用にする（docs/agents/common.md に運用ルールとして明記）。
--
-- 2. [important] drift_type にCHECK制約が無くタイポ等を防げなかった。
--    SPEC.md記載の`error`種別は実装（例外捕捉ハンドラ）が伴わない未使用値だった
--    ため、v1スコープでは`error`を削除し、実装済みの3種類のみに制約する。
--
-- 3. [important] 自己参照ガードがテーブルの「存在」のみを見ており、
--    schema_baseline_snapshotsの行だけが空になるケース（テーブル自体は残る）は
--    検知されずサイレントに「ドリフトなし」を返していた。行数0件も同様に
--    エラー扱いにする。
--
-- 4. [minor] record_schema_drift()がcheck_schema_drift()を2回呼び毎日のcronで
--    無駄な二重フルスキャンをしていたため、1回の結果をCTEで使い回すよう変更。

ALTER TABLE schema_drift_log
  ADD CONSTRAINT schema_drift_log_drift_type_check
  CHECK (drift_type IN ('rls_disabled', 'table_added', 'table_removed'));

CREATE OR REPLACE FUNCTION refresh_schema_baseline_snapshot(new_epoch TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO schema_baseline_snapshots (epoch, snapshot)
  SELECT new_epoch, jsonb_agg(tablename ORDER BY tablename)
  FROM pg_tables WHERE schemaname = 'public'
  ON CONFLICT (epoch) DO NOTHING;
END;
$$;
GRANT EXECUTE ON FUNCTION refresh_schema_baseline_snapshot TO service_role;

CREATE OR REPLACE FUNCTION check_schema_drift()
RETURNS TABLE (drift_type TEXT, object_name TEXT, detail JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  latest_snapshot JSONB;
  snapshot_row_count INT;
BEGIN
  IF to_regclass('public.schema_drift_log') IS NULL
     OR to_regclass('public.schema_baseline_snapshots') IS NULL THEN
    RAISE EXCEPTION 'schema drift detection base tables are missing (self-referential integrity failure)';
  END IF;

  SELECT COUNT(*) INTO snapshot_row_count FROM schema_baseline_snapshots;
  IF snapshot_row_count = 0 THEN
    RAISE EXCEPTION 'schema_baseline_snapshots is empty (self-referential integrity failure: baseline was cleared)';
  END IF;

  SELECT snapshot INTO latest_snapshot
  FROM schema_baseline_snapshots ORDER BY epoch DESC LIMIT 1;

  RETURN QUERY
  SELECT 'rls_disabled', c.relname::TEXT, jsonb_build_object('schema', 'public')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = false;

  RETURN QUERY
  SELECT 'table_added', t.tablename::TEXT, jsonb_build_object('schema', 'public')
  FROM pg_tables t
  WHERE t.schemaname = 'public'
    AND NOT (latest_snapshot ? t.tablename);

  RETURN QUERY
  SELECT 'table_removed', s.name, jsonb_build_object('schema', 'public')
  FROM jsonb_array_elements_text(latest_snapshot) AS s(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename = s.name
  );
END;
$$;

CREATE OR REPLACE FUNCTION record_schema_drift()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- check_schema_drift()は3本のpg_catalogフルスキャンを含むため、INSERT/UPDATE
  -- それぞれで呼ぶと日次cronのたびに二重スキャンになっていた。1回だけ呼び、
  -- 一時テーブルに結果を保持して両方の操作で使い回す
  CREATE TEMP TABLE IF NOT EXISTS _current_schema_drift ON COMMIT DROP AS
  SELECT * FROM check_schema_drift();

  INSERT INTO schema_drift_log (drift_type, object_name, detail)
  SELECT d.drift_type, d.object_name, d.detail FROM _current_schema_drift d
  ON CONFLICT (drift_type, object_name) WHERE resolved_at IS NULL DO NOTHING;

  UPDATE schema_drift_log l
  SET event_kind = 'resolved', resolved_at = now()
  WHERE l.event_kind = 'detected' AND l.resolved_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM _current_schema_drift d
      WHERE d.drift_type = l.drift_type AND d.object_name = l.object_name
    );
END;
$$;

-- このmigration自体がpublicテーブル構成を変えるものではないため、baseline更新は不要
-- （schema_drift_log_drift_type_check等はテーブル自体の追加/削除ではなくCHECK制約の追加）
