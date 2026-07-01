-- 本番デプロイ前に実行するSQL
-- user_facilities に role='admin' を設定するサンプル（メールアドレスは実際のものに置き換える）
--
-- WHY: requireAdmin() はDB roleベースで判定するため、既存管理者に
--      role='admin' を設定しないと ADMIN_EMAILS フォールバックに依存し続ける。
--      このSQLを実行してDBにadmin行を1件以上作成することで、
--      ADMIN_EMAILS 環境変数への依存を解消できる。
--
-- 実行前の確認:
--   SELECT * FROM user_facilities WHERE role = 'admin';
--   → 0件であることを確認してから実行する
--
-- 実行後の確認:
--   SELECT uf.user_id, au.email, uf.role
--   FROM user_facilities uf
--   JOIN auth.users au ON uf.user_id = au.id
--   WHERE uf.role = 'admin';
--   → 対象管理者が含まれることを確認する

UPDATE user_facilities
SET role = 'admin'
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'YOUR_ADMIN_EMAIL');
