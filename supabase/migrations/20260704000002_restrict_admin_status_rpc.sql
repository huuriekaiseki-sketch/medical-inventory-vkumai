-- WHY: get_admin_status は resolveIsAdmin() からのみ呼ばれ、呼び出し元（requireAdmin/
--      requireFacilityAccess/middleware）はいずれも認証済みユーザーに対してのみ使う。
--      未認証ユーザー（anon）に実行権限を与える必要がないため、20260704000001 で
--      過剰に付与した anon への EXECUTE 権限を取り消す。

REVOKE EXECUTE ON FUNCTION get_admin_status FROM anon;
