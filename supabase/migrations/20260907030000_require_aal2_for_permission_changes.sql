-- supabase/migrations/20260907030000_require_aal2_for_permission_changes.sql
-- release-order: db-first
--   （ポリシーと GRANT を先に入れる。アプリが service_role のままでも壊れない。
--     アプリ側を利用者の JWT に切り替えるのは同じ PR の中だが、順序は DB が先）
-- design: 権限=admin かつ aal2 のみ書ける（読みは従来どおり自分の行だけ）／大きさ・量・消え方は
--         20260627010000 から変えない／記録=監査対象（TB-030、既に対象）／外部送信なし
--
-- WHY: 2026-09-07 の「権限変更と書き込みの競合」の調査で、窓より大きい穴が見つかった。
--
--      20260906000008（issue #623 の続き、P-033）はマスタの書き込みに `has_aal2()` を足したが、
--      **所属と役割の変更（誰を admin にするか）には aal2 が要らないまま**だった。
--      理由は経路の違いで、マスタは利用者の JWT → RLS を通るのに対し、
--      所属の変更は管理 API が **service_role（RLS を通らない鍵）**で書いており、
--      認可は `requireAdmin()` だけ（aal2 を見ていない）だったため。
--
--      結果として、パスワードだけを奪われた admin（MFA 登録済み・aal1）は
--      マスタを直接は書けないのに、**共犯者を admin に昇格させることはできた**。
--      #623 と P-033 で塞いだつもりの経路を、権限を配る側から迂回できる状態だった。
--
--      ここで `user_facilities` に書き込みポリシーを作り、アプリを利用者の JWT に切り替える。
--      副産物として、認可の再評価が書き込みと同じ文の中で起きるので
--      「判定してから書くまでの窓」（実測 25 ms で 12 本中 8 本が通った）も消える。
--
-- WHY(has_aal2 の性質): `has_aal2()` は **verified な TOTP factor を持たない利用者には TRUE** を返す。
--      MFA 未登録の admin は今までどおり書ける（運用は変わらない）。
--      MFA を登録した admin は aal2 へ昇格してから権限を変えることになる。
--
-- ROLLBACK:
--   DROP POLICY "admin_write" ON user_facilities;
--   REVOKE INSERT, UPDATE, DELETE ON TABLE public.user_facilities FROM authenticated;
--   （アプリ側も createAdminSupabase() に戻す）

-- 1. admin かつ aal2 だけが所属と役割を書ける
--    SELECT は従来どおり self_read（自分の行だけ）。ここでは触らない。
CREATE POLICY "admin_write" ON user_facilities
  FOR ALL TO authenticated
  USING (is_admin() AND has_aal2())
  WITH CHECK (is_admin() AND has_aal2());

-- 2. ポリシーが効くには権限が要る（GRANT を書かなければポリシー以前に拒否される）
GRANT INSERT, UPDATE, DELETE ON TABLE public.user_facilities TO authenticated;

-- 権限とポリシーの変更のみでテーブル新設/削除ではないため refresh_schema_baseline_snapshot は不要。
