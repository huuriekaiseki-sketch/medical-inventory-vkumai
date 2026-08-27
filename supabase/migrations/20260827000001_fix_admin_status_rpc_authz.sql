-- WHY: get_admin_status(p_user_id UUID) はSECURITY DEFINER（RLSバイパス）で動くにも
--      かかわらず、渡されたp_user_idが呼び出し本人かどうかを一切確認していなかった。
--      authenticatedロールなら誰でも実行権限を持つため、任意のp_user_idを指定して
--      他人の管理者フラグを取得できてしまう情報漏えいが存在した。
--      対応として、パラメータを完全に廃止しauth.uid()（呼び出し本人のID）のみを使う
--      シグネチャに変更する。パラメータが存在しなければ他人を指定する余地自体がなくなる。
-- WHY(DROP FUNCTIONが先頭で必要な理由): CREATE OR REPLACE FUNCTIONは引数の型（シグネチャ）
--      が異なると別関数として扱われ、旧関数get_admin_status(UUID)が新関数
--      get_admin_status()と共存してしまう。明示的にDROPしないと脆弱な旧関数が
--      呼び出し可能なまま残り続けるため、必ず先にDROPする。
-- WHY(SET search_path = ''): 20260804000001_harden_order_rpc_search_path.sqlで確立した
--      search_path hijacking対策の現行慣行に合わせ、テーブル参照をpublic.で完全修飾する。

DROP FUNCTION IF EXISTS get_admin_status(UUID);

CREATE OR REPLACE FUNCTION get_admin_status()
RETURNS TABLE (user_is_admin BOOLEAN, db_has_admin BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.user_facilities WHERE user_id = auth.uid() AND role = 'admin'),
    EXISTS (SELECT 1 FROM public.user_facilities WHERE role = 'admin');
$$;

-- WHY(REVOKE FROM PUBLICが先に必要な理由): CREATE OR REPLACE FUNCTIONで新規作成された
--      関数オブジェクトには、PostgreSQLのデフォルト仕様によりPUBLIC(=anon含む全ロール)へ
--      EXECUTE権限が自動付与される。旧関数get_admin_status(UUID)に対する
--      20260704000002_restrict_admin_status_rpc.sqlのREVOKEは別オブジェクト（別シグネチャ）
--      に対するものであり、この新オブジェクトには一切引き継がれない。GRANTだけを実行しても
--      PUBLICへの自動付与分がそのまま残り、anon(未認証)が呼び出せてしまうため、必ず先に
--      REVOKEしてから明示的にGRANTし直す。
REVOKE ALL ON FUNCTION get_admin_status() FROM PUBLIC;

-- WHY(anonを含めない): 20260704000002_restrict_admin_status_rpc.sqlで未認証ユーザー(anon)
--      への実行権限を取り消した意図を、シグネチャ変更後も維持する。
GRANT EXECUTE ON FUNCTION get_admin_status() TO authenticated, service_role;
