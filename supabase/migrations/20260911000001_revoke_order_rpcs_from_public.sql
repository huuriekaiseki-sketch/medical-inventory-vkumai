-- supabase/migrations/20260911000001_revoke_order_rpcs_from_public.sql
-- release-order: db-first
--
-- WHY(2026-09-11・E-074): 発注の 4 本（症例・消耗品・短貸・返却）は
--      `GRANT EXECUTE ... TO authenticated` としか書いていない。にもかかわらず
--      **未ログイン（anon）でも呼べていた**。2026-09-11 に実測して分かった
--      （`rpc-boundary-sweep` に「未ログインで呼べる RPC は宣言と一致する」を足したら、
--      この 4 本が「宣言に無いのに呼べる」で出た）。
--
--      理由は PostgreSQL の既定で、`CREATE FUNCTION` は **PUBLIC に EXECUTE を付ける**。
--      `GRANT ... TO authenticated` を書いても PUBLIC の分は消えないので、
--      **「TO authenticated と書いたから authenticated だけ」という読みが成り立たない**。
--      関数は表と違い、GRANT を書かなくても既定で全員に開いている。
--
--      実害は今のところ無い（4 本とも SECURITY DEFINER の中で `is_facility_writer()` /
--      `has_aal2()` を見ており、未ログインでは例外になって行は増えない。掃きの
--      「施設 A の行が変わらない」が毎回それを実測している）。
--      それでも**呼べること自体を残さない**——中の判定が 1 行崩れた瞬間に、
--      認証すら要らない入口になるため。多層防御として権限側でも閉じる。
--
-- WHY(名前で回す): この 4 本は引数を増やした版が後から入っており（20260906000006 で
--      `p_client_request_id` を追加）、**古い署名の関数が残っていることがある**。
--      署名を列挙すると取りこぼすので、名前で全オーバーロードに当てる。
--      取りこぼしが無いことは統合テストが実測する（署名ではなく「呼べるか」を見るため）。
--
-- WHY(service_role にも配り直す): `REVOKE ALL ... FROM PUBLIC` は service_role が
--      PUBLIC 経由で持っていた分も外す。サーバー側の処理と統合テストが呼べなくなるので明示で戻す。

DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'create_case_order_atomic',
        'create_consumable_order_atomic',
        'create_loan_order_atomic',
        'create_loan_return_atomic'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn.sig);
  END LOOP;
END
$$;

-- ROLLBACK: 下の DO ブロックで PUBLIC へ配り直す。
--   未認証から呼べる状態に戻ることになるので通常は不要。
--   DO $$
--   DECLARE fn RECORD;
--   BEGIN
--     FOR fn IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
--       JOIN pg_namespace n ON n.oid = p.pronamespace
--       WHERE n.nspname = 'public' AND p.proname IN (
--         'create_case_order_atomic', 'create_consumable_order_atomic',
--         'create_loan_order_atomic', 'create_loan_return_atomic')
--     LOOP
--       EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', fn.sig);
--     END LOOP;
--   END $$;

-- 関数権限の変更のみでテーブルの新設・削除ではないため refresh_schema_baseline_snapshot は不要。
