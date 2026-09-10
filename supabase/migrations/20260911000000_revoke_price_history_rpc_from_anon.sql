-- supabase/migrations/20260911000000_revoke_price_history_rpc_from_anon.sql
-- release-order: db-first
--
-- WHY(2026-09-11): eval の陰性対照で Sweep が実コードを掃いたとき（2026-09-10）に挙がった指摘を、
--      人が実測して確かめた。`get_distributor_product_price_history` は
--        - `SECURITY DEFINER` なので **RLS を通らない**
--        - 代理店商品側の分岐（マスタの仕切値）には認可の条件が 1 つも無い
--        - `GRANT EXECUTE ... TO anon`（20260622000000:117）が付いたまま
--      の 3 つが重なっており、**ログインせずに全代理店商品の仕切値の変更履歴が読めた**。
--      2026-09-11 に統合テストで実測して確認している（`price-histories-rls-idor` の
--      「価格履歴の RPC も呼べない」を先に足したら赤で入った）。
--
--      表そのものは 20260626001000:65 の `REVOKE ALL ON price_histories FROM anon` で既に
--      締まっており、未ログインでは 1 行も読めない（同じ実測で確認）。**開いていたのは RPC だけ**。
--      `docs/agents/design-questions.md` の 4d には「表のポリシーが `TO anon, authenticated`」とも
--      書いてあったが、これは 20260622 の初版を読んだ記述で実態とは違っていた（同日に訂正した）。
--
--      公開範囲の判断は人に聞いた（2026-09-11）。**未認証には見せない**。
--      施設で絞れないマスタであることと、未認証に開くことは別の話、という理由。
--      認証済みの利用者に対しては従来どおりテナント非分離のままで、振る舞いを変えない。
--
-- WHY(REVOKE は 2 本要る、2026-09-11 実測): 関数の EXECUTE は **2 つの経路**で anon に届く。
--        (a) PUBLIC への既定の EXECUTE（PostgreSQL は CREATE FUNCTION 時に PUBLIC へ付ける）
--        (b) anon への明示的な GRANT（20260622000000:117。Supabase の
--            ALTER DEFAULT PRIVILEGES でも同じものが付く）
--      **片方だけ外しても呼べたまま**になる。20260906000002 は (a) だけを外して (b) が残り、
--      素の DB で anon から呼べていた。今回はその**逆**で、先に `FROM anon` だけを書いたら
--      統合テストが赤のままだった（(a) が残っていた）。両方外してから、要るロールにだけ配り直す。
--
--      `CREATE OR REPLACE` は既存の ACL を保つので、この REVOKE は後の再定義でも残る。
--      ただし DROP + CREATE されれば既定の PUBLIC 権限ごと復活するので、
--      **実 DB で「anon は呼べない」を測る統合テスト**を同時に足した
--      （supabase/__tests__/integration/price-histories-rls-idor.integration.test.ts）。

REVOKE ALL ON FUNCTION get_distributor_product_price_history(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_distributor_product_price_history(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION get_distributor_product_price_history(UUID) TO authenticated, service_role;

-- ROLLBACK: GRANT EXECUTE ON FUNCTION get_distributor_product_price_history(UUID) TO anon;
--   未認証へ再び開くことになるので通常は不要。

-- 関数権限の変更のみでテーブルの新設・削除ではないため refresh_schema_baseline_snapshot は不要。
