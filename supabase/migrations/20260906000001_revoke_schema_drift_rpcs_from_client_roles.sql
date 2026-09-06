-- supabase/migrations/20260906000001_revoke_schema_drift_rpcs_from_client_roles.sql
-- issue #757 の 34（未テスト経路の自動検出）で入れた RPC 公開判定（P-043、PR #760）の初回計測で発見。
--
-- WHY: 20260714000001 / 20260714000003 は schema drift 系 4 関数を「service_role のみ実行可能
--      （authenticated/anon への付与はしない）」と注記して GRANT EXECUTE ... TO service_role だけを
--      書いたが、PostgreSQL は CREATE FUNCTION した関数の EXECUTE を既定で PUBLIC に与えるため、
--      GRANT を書かないことは「呼べない」を意味しない。実測（2026-09-06、ローカル Supabase）では
--      anon キーだけで check_schema_drift() と record_issue_url() が呼べた。
--      record_issue_url / refresh_schema_baseline_snapshot / record_schema_drift は SECURITY DEFINER
--      の書き込み関数なので、anon キーを持つ誰でも drift 検知の baseline と記録を書き換えられる
--      ＝監視を盲目にできる状態だった（施設データそのものは読めない。RLS はテーブル側で守られている）。
--
--      是正: PUBLIC 既定と client ロールから EXECUTE を外し、service_role にだけ残す。
--      pg_cron のジョブ（20260714000002）は postgres ロールで動くため影響なし。
--      GitHub Actions（schema-drift-check.yml）は drift_alert_view の SELECT だけを使い、
--      record_issue_url は呼んでいない（同 yml の注記）ため影響なし。
--      migration の末尾で呼ぶ refresh_schema_baseline_snapshot（.claude/rules/db-schema.md）は
--      migration 実行ロール（postgres）で動くため影響なし。
--
--      同種の見逃しは constraint_coverage_ratchet.test.ts の P-043 が以後は機械検知する
--      （GRANT を書かない関数は「PUBLIC 既定で呼べる」として列挙される）。

REVOKE ALL ON FUNCTION check_schema_drift() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION record_schema_drift() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION record_issue_url(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION refresh_schema_baseline_snapshot(TEXT) FROM PUBLIC, anon, authenticated;

-- service_role への GRANT は既存だが、REVOKE ALL ... FROM PUBLIC の後も残ることを明示する（冪等）
GRANT EXECUTE ON FUNCTION check_schema_drift() TO service_role;
GRANT EXECUTE ON FUNCTION record_schema_drift() TO service_role;
GRANT EXECUTE ON FUNCTION record_issue_url(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION refresh_schema_baseline_snapshot(TEXT) TO service_role;

-- ROLLBACK（元の状態＝PUBLIC 既定に戻す。安全側ではないので通常は不要）:
--   GRANT EXECUTE ON FUNCTION check_schema_drift() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION record_schema_drift() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION record_issue_url(UUID, TEXT) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION refresh_schema_baseline_snapshot(TEXT) TO PUBLIC;

-- 関数権限の変更のみでテーブル新設/削除ではないため、refresh_schema_baseline_snapshot の呼び出しは不要。
