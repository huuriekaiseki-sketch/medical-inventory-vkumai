-- =========================================================================
-- user_facilities のテーブル権限付与（issue #165 CI失敗の是正）
-- =========================================================================
-- WHY: 本リポジトリはデフォルト権限に頼らず、CREATE TABLE直後に明示的な
--      GRANTを書く規約（例: 20260619013819_grant_table_permissions.sql,
--      20260624000000_add_orders.sqlのL112-120）だが、user_facilities
--      （20260627010000_add_multitenant.sql）だけこのGRANTが漏れていた。
--      ローカル開発環境では既存インスタンスに残っていた過去の権限設定に
--      たまたま救われて動作していたが、supabase db resetで作り直した
--      クリーンなCI環境では「permission denied for table user_facilities」
--      で失敗することが issue #165 のRLS/IDOR統合テスト追加時に判明した。
--
--      authenticatedにはSELECTのみ付与する（書き込みはservice_roleのみ、
--      というuser_facilitiesのRLS設計意図（self_readポリシーのみ存在し
--      INSERT/UPDATE/DELETEポリシーが無い）を、GRANT側でも踏襲するため）。
GRANT SELECT ON TABLE public.user_facilities TO authenticated;
GRANT ALL    ON TABLE public.user_facilities TO postgres, service_role;
