-- supabase/migrations/20260906000002_revoke_get_admin_status_from_anon.sql
-- P-045（rpc-boundary.integration.test.ts）を CI の素の DB で回して発見（2026-09-06）。
--
-- WHY: 20260827000001 は get_admin_status() を作り直したあと
--        REVOKE ALL ON FUNCTION get_admin_status() FROM PUBLIC;
--        GRANT EXECUTE ON FUNCTION get_admin_status() TO authenticated, service_role;
--      と書き、コメントで「anon を含めない」意図を明記した。しかし Supabase の DB には
--      postgres ロールの ALTER DEFAULT PRIVILEGES（public スキーマの関数に anon / authenticated /
--      service_role へ EXECUTE を付与）が入っており、CREATE FUNCTION の時点で anon に**明示的な**
--      EXECUTE が付く。REVOKE ... FROM PUBLIC は PUBLIC 経由の権限しか外さないため、anon の明示権限は
--      残り、migration 全適用の素の DB（CI・本番の初期化）では anon キーだけで呼べた。
--      増分適用してきたローカル DB では拒否されていたため、手元では気づけなかった。
--
--      anon が得られるのは (user_is_admin=false, db_has_admin) だけで、施設データは読めないが、
--      「admin が 1 人以上いるか」を未認証で知れるのは意図と違う。明示的に anon から外す。
--
--      教訓は docs/agents/known-failure-patterns.md「GRANT を書いていない＝呼べない、と読む」に追記。
--      以後、client に公開しない関数は REVOKE ... FROM PUBLIC, anon, authenticated を 3 つとも書く
--      （20260906000001 と同じ形）。

REVOKE EXECUTE ON FUNCTION get_admin_status() FROM anon;

-- ROLLBACK（元の状態に戻す。安全側ではないので通常は不要）:
--   GRANT EXECUTE ON FUNCTION get_admin_status() TO anon;

-- 関数権限の変更のみでテーブル新設/削除ではないため、refresh_schema_baseline_snapshot の呼び出しは不要。
