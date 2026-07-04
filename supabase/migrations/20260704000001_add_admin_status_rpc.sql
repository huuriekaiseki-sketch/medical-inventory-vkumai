-- WHY: Edge Runtime(middleware.ts)ではservice role keyが使えないため、
--      RLSをバイパスしつつservice role keyなしでadmin判定に必要な2つのフラグ
--      （自分がadminか／DB全体にadminが1件でもいるか）を返すSECURITY DEFINER RPCを新設する。
--      ADMIN_EMAILSフォールバックはPostgres側から読めないため、TS側(resolveIsAdmin)に残す。

CREATE OR REPLACE FUNCTION get_admin_status(p_user_id UUID)
RETURNS TABLE (user_is_admin BOOLEAN, db_has_admin BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    EXISTS (SELECT 1 FROM user_facilities WHERE user_id = p_user_id AND role = 'admin'),
    EXISTS (SELECT 1 FROM user_facilities WHERE role = 'admin');
$$;

GRANT EXECUTE ON FUNCTION get_admin_status TO anon, authenticated, service_role;
