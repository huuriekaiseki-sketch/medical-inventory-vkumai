-- supabase/migrations/20260907010000_grant_schema_drift_log_read.sql
-- issue #757 の 24 の作業中に発見。
--
-- WHY: `schema_drift_log` は 20260714000001 で作られて以来、テーブルへの GRANT が
--      1 行も書かれていない。RLS は有効でポリシーは 0（SECURITY DEFINER 関数からしか
--      書かない設計なので、それ自体は意図どおり）。だが読む側の手当ても無かったため、
--      **service_role でも `permission denied for table schema_drift_log` になる**。
--      2026-09-07 に実測して確認した。
--
--      その結果、夜間の不変条件検査（20260906000005）を守るはずの
--      supabase/__tests__/integration/business-invariants-nightly.integration.test.ts が
--      「記録されたか」を読めず、ずっと落ちたままだった。
--      記録そのものは動いている（anon 公開の drift_alert_view には
--      `invariant_violation` の行が出ることを実測で確認済み）。
--      つまり「仕組みは動いていたが、それを守るテストが確かめられていなかった」。
--
--      あわせて、`detail`（何がどう違反したか）は誰も読めない状態だった。
--      drift_alert_view は detail を意図的に外しているので、原因の調べようが無い。
--
-- 何を変えるか: service_role にだけ SELECT を与える。service_role はサーバー側だけが持つ鍵で、
--      もともと全施設の業務データを読める。監視の記録を読めるようにしても露出は増えない。
--      client ロール（anon / authenticated）には与えない（従来どおり drift_alert_view のみ）。
--      audit_log（20260906000004）と同じく、Supabase の既定権限に頼らず
--      REVOKE してから必要な分だけ GRANT する。
--
-- ROLLBACK: REVOKE SELECT ON TABLE schema_drift_log FROM service_role;

REVOKE ALL ON TABLE schema_drift_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE schema_drift_log TO service_role;

REVOKE ALL ON TABLE schema_baseline_snapshots FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE schema_baseline_snapshots TO service_role;

-- テーブル新設/削除ではないため refresh_schema_baseline_snapshot の呼び出しは不要。
