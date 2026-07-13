-- WHY: check_schema_drift()/record_schema_drift()の記録は20260714000001で用意したが、
--      日次で自動実行するにはDB内部スケジューラ(pg_cron)への登録が必要。
--      pg_cron拡張の有効化はSPEC.md issue #305 Part1の判断事項1で承認済み。
--      CREATE EXTENSION自体はマイグレーションで冪等に行い、環境間の差異を吸収する
--      （Supabase Dashboard側でも有効化するが、ローカル/新規環境の再現性のためmigrationにも残す）。

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- UTC 23:00 = JST 8:00。GitHub Actions側の日次チェック（UTC 0:00）より前に実行し、
-- DB側の記録を先に完了させてからGitHub Actionsがdrift_alert_viewを読みに来る順序にする。
SELECT cron.schedule(
  'schema-drift-daily-check',
  '0 23 * * *',
  $$ SELECT record_schema_drift(); $$
);
