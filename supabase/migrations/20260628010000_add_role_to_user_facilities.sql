-- supabase/migrations/20260628010000_add_role_to_user_facilities.sql
-- WHY: admin が全施設にアクセスする RLS 条件を書くために、
--      user_facilities に role を持たせ、is_admin() で判定できるようにする。
--      role は施設ごとに持つが、is_admin() は「いずれかの施設で admin なら true」とする。

-- =========================================================================
-- 1. role カラム追加
-- =========================================================================
ALTER TABLE user_facilities
  ADD COLUMN role TEXT NOT NULL DEFAULT 'staff';

ALTER TABLE user_facilities
  ADD CONSTRAINT user_facilities_role_check
  CHECK (role IN ('staff', 'admin'));

-- =========================================================================
-- 2. is_admin ヘルパー関数
-- =========================================================================
-- ⚠️  本番適用後の必須手順:
--     ADMIN_EMAILS 環境変数に登録されている各ユーザーに role='admin' を設定すること。
--     以下の SQL をメールアドレスを置き換えて Supabase Dashboard の SQL Editor で実行:
--
--     UPDATE user_facilities uf
--       SET role = 'admin'
--       FROM auth.users u
--       WHERE u.id = uf.user_id
--         AND u.email = ANY(ARRAY['admin@example.com']);
--
-- =========================================================================
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_facilities
    WHERE user_id = auth.uid() AND role = 'admin'
  );
$$;
