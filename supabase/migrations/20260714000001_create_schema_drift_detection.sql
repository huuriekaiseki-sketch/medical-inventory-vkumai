-- WHY: PRを介さない本番スキーマ変更（SQL Editor等での直接操作）を検知するための土台。
--      GitHub Integration（issue #30）はPR/ブランチトリガーでのみ動作するため、
--      PRの外側で行われた変更は次にPRが発生するまで検知が遅延する（rls_auto_enableイベント
--      トリガーが実際にPRを介さず入っていた事故パターン、20260707000001参照）。
--      DB内部で毎日1回スキャンし、ログに記録する仕組みをここで用意する
--      （日次実行スケジュール自体は 20260714000002 で pg_cron に登録する）。
--      v1スコープはRLS無効化・テーブル追加・テーブル削除の3種類のみ
--      （関数・カラム・トリガー・制約等はv2以降。SPEC.md issue #305 Part2参照）。

-- 1. baseline snapshot（append-only）
--    テーブル追加/削除の判定基準。手動でのテーブル名列挙はせず、
--    このmigration適用時点のpg_tables実データをそのまま封印する
--    （導出漏れリスクを構造的に避けるため。過去の未記録ドリフトがあってもここが合格ラインになる）
CREATE TABLE schema_baseline_snapshots (
  epoch TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE schema_baseline_snapshots ENABLE ROW LEVEL SECURITY;
-- service_role以外へのポリシーは意図的に作らない（= service_roleのみアクセス可。既存パターンに合わせる）

-- 2. ドリフトログ（append-only、冪等性は部分ユニーク制約で担保）
CREATE TABLE schema_drift_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drift_type TEXT NOT NULL,
  object_name TEXT,
  detail JSONB,
  event_kind TEXT NOT NULL DEFAULT 'detected' CHECK (event_kind IN ('detected','acknowledged','resolved')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  issue_url TEXT
);

-- 同一drift_type+object_nameの未解決行は1件に限定する（record_schema_drift()の冪等insertが
-- このインデックスをON CONFLICTの対象にする）
CREATE UNIQUE INDEX schema_drift_log_open_unique
  ON schema_drift_log (drift_type, object_name) WHERE resolved_at IS NULL;

ALTER TABLE schema_drift_log ENABLE ROW LEVEL SECURITY;
-- service_role以外へのポリシーは意図的に作らない（drift_alert_viewが公開用の唯一の窓口）

-- 3. 初期snapshot（このmigration適用時点の実データをそのまま封印）
INSERT INTO schema_baseline_snapshots (epoch, snapshot)
SELECT '20260714000001', jsonb_agg(tablename ORDER BY tablename)
FROM pg_tables WHERE schemaname = 'public';

-- 4. check_schema_drift(): 3種のドリフトを検知して返す（副作用なし・純粋な検知のみ）
CREATE OR REPLACE FUNCTION check_schema_drift()
RETURNS TABLE (drift_type TEXT, object_name TEXT, detail JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  latest_snapshot JSONB;
BEGIN
  -- 自己参照ガード: 基盤テーブル自体が消えた場合は検知どころではないため、
  -- そのままエラーとして失敗させる（pg_cronの実行履歴に失敗が残る想定。受け入れ条件チェックリスト参照）
  IF to_regclass('public.schema_drift_log') IS NULL
     OR to_regclass('public.schema_baseline_snapshots') IS NULL THEN
    RAISE EXCEPTION 'schema drift detection base tables are missing (self-referential integrity failure)';
  END IF;

  SELECT snapshot INTO latest_snapshot
  FROM schema_baseline_snapshots ORDER BY epoch DESC LIMIT 1;

  -- 1. RLS無効化検知（ホワイトリスト不要、public全テーブル対象。
  --    自テーブル(schema_baseline_snapshots/schema_drift_log)もRLS有効化前提のため対象に含む）
  RETURN QUERY
  SELECT 'rls_disabled', c.relname::TEXT, jsonb_build_object('schema', 'public')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = false;

  -- 2. テーブル追加検知
  RETURN QUERY
  SELECT 'table_added', t.tablename::TEXT, jsonb_build_object('schema', 'public')
  FROM pg_tables t
  WHERE t.schemaname = 'public'
    AND NOT (latest_snapshot ? t.tablename);

  -- 3. テーブル削除検知
  RETURN QUERY
  SELECT 'table_removed', s.name, jsonb_build_object('schema', 'public')
  FROM jsonb_array_elements_text(latest_snapshot) AS s(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename = s.name
  );
END;
$$;
-- service_roleのみ実行可能（受け入れ条件「セキュリティ」参照。authenticated/anonへの付与はしない）
GRANT EXECUTE ON FUNCTION check_schema_drift TO service_role;

-- 5. record_schema_drift(): check_schema_drift()の結果を冪等insertし、
--    再検知されなくなったdetected行を自動でresolvedにする
CREATE OR REPLACE FUNCTION record_schema_drift()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- 新規ドリフトを記録（既存の未解決行があればスキップ = 重複記録を防ぐ）
  INSERT INTO schema_drift_log (drift_type, object_name, detail)
  SELECT d.drift_type, d.object_name, d.detail FROM check_schema_drift() d
  ON CONFLICT (drift_type, object_name) WHERE resolved_at IS NULL DO NOTHING;

  -- 前回検知されたが今回検知されなかった行はresolvedにする
  UPDATE schema_drift_log l
  SET event_kind = 'resolved', resolved_at = now()
  WHERE l.event_kind = 'detected' AND l.resolved_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM check_schema_drift() d
      WHERE d.drift_type = l.drift_type AND d.object_name = l.object_name
    );
END;
$$;
GRANT EXECUTE ON FUNCTION record_schema_drift TO service_role;

-- 6. GitHub Actions公開用ビュー（詳細非公開・未解決分のみ。detail列は含めない）
CREATE VIEW drift_alert_view AS
SELECT id, drift_type, object_name, detected_at, issue_url
FROM schema_drift_log
WHERE event_kind = 'detected' AND resolved_at IS NULL;
-- anonでもSELECTのみ可能（drift_type・object_name・detected_atのみ公開。detail列は非公開）
GRANT SELECT ON drift_alert_view TO anon;

-- 7. record_issue_url(): GitHub Actionsが作成したIssue URLをログに書き戻すための専用RPC
--    （.github/workflows/schema-drift-check.yml から service_role権限で呼び出される想定。
--     Set 3側の追加スコープとしてSet 1に含める。SPEC.md Part2セット3参照）
CREATE OR REPLACE FUNCTION record_issue_url(log_id UUID, url TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE schema_drift_log SET issue_url = url WHERE id = log_id;
END;
$$;
GRANT EXECUTE ON FUNCTION record_issue_url TO service_role;
