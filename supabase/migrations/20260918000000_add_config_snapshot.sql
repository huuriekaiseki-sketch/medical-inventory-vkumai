-- supabase/migrations/20260918000000_add_config_snapshot.sql
-- release-order: db-first
-- contract: 足すだけ（新しい関数 1 つ）。既存のどの表・列・関数も変えないので、
--   古いアプリと新しい DB が混在しても壊れない。アプリ側はこの関数を呼ばない
--   （呼ぶのは検査スクリプト `scripts/check-config-drift.sh` だけ）。
-- lock: 書き込みを止める DDL は無い。CREATE FUNCTION と GRANT/REVOKE だけで、
--   既存の表には触れない。
-- ROLLBACK: DROP FUNCTION IF EXISTS public.config_snapshot();
--
-- WHY(issue #757 の 35): 設定ドリフト検知。migration から導いた「期待値」と実環境の権限・
--   ポリシーを突き合わせるには、**実環境の側を読む口**が要る。
--
--   この口をどう作るかで 3 案あった（2026-09-18）:
--     (a) psql で直接読む → **この開発機に psql が無い**。docker exec はローカル専用で本番に届かない
--     (b) node の postgres クライアント（pg）を足す → 依存が増える
--     (c) 関数を 1 つ置き、既に使っている supabase-js から呼ぶ → **採用**
--   (c) なら依存を増やさず、本番にも staging にも同じ経路で届く。
--   既存のスキーマドリフト検知（issue #305）が `check_schema_drift()` を置いているのと同じ型。
--
-- WHY(SECURITY DEFINER を付けない): docs/agents/common.md の
--   「施設スコープ RPC はまず DEFINER なし（RLS 自動適用）を検討する」に従う。
--   読むのは `pg_catalog` と `pg_policies` だけで、これらは PUBLIC が読める。
--   **呼び出し元の権限のままで足りる**ので DEFINER は要らない。
--   （`information_schema.role_table_grants` は「自分に関係する行」しか返さないため使わない。
--     `pg_class.relacl` を直接読む。C-044 の型——絞られた一覧を全体と読むと嘘の「差分なし」が出る）
--
-- WHY(service_role だけに許す): 返すのは業務データではなく権限の構造だが、
--   「誰が何をできるか」の一覧は攻撃者にとって地図になる。読める相手を最小にする。
--
-- 限界:
--   - 返すのは public スキーマの表・ビュー・関数と、そのポリシー名だけ。
--     Storage policy・GitHub のブランチ保護・Vercel の環境変数は**含まない**（外部の口が別）
--   - ポリシーの**中身**（USING 句）は返さない。名前と表と操作だけ。中身の正しさは
--     RLS 変異計測（H-06）と直接攻撃の実測の担当

CREATE OR REPLACE FUNCTION public.config_snapshot()
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'tableGrants', COALESCE((
      SELECT jsonb_agg(row_to_json(t) ORDER BY t.object, t.role)
      FROM (
        SELECT c.relname AS object,
               a.grantee::regrole::text AS role,
               array_agg(DISTINCT a.privilege_type ORDER BY a.privilege_type) AS privileges
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS a
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'v', 'm', 'p')
          AND a.grantee <> 0
          AND a.grantee::regrole::text IN ('anon', 'authenticated', 'service_role')
        GROUP BY c.relname, a.grantee
      ) t
    ), '[]'::jsonb),
    'functionGrants', COALESCE((
      SELECT jsonb_agg(row_to_json(t) ORDER BY t.object, t.role)
      FROM (
        -- WHY(引数名を出さない、2026-09-18 実測): pg_get_function_identity_arguments() は
        --   `p_facility_id uuid` のように**引数名つき**で返す。migration 側には型しか書かれていないので、
        --   そのまま比べると関数の全件が「期待に無い」と「実環境に無い」の両方に出た（41 対 33 で全滅）。
        --   format_type で**型だけ**を出し、突き合わせる形を揃える。
        SELECT p.proname || '(' || COALESCE((
                 SELECT string_agg(format_type(t, NULL), ',' ORDER BY ord)
                 FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)
               ), '') || ')' AS object,
               a.grantee::regrole::text AS role,
               array_agg(DISTINCT a.privilege_type ORDER BY a.privilege_type) AS privileges
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
        WHERE n.nspname = 'public'
          AND a.grantee <> 0
          AND a.grantee::regrole::text IN ('anon', 'authenticated', 'service_role')
        GROUP BY p.proname, p.proargtypes, a.grantee
      ) t
    ), '[]'::jsonb),
    'policies', COALESCE((
      SELECT jsonb_agg(row_to_json(t) ORDER BY t.object, t.name)
      FROM (
        SELECT tablename AS object, policyname AS name, cmd
        FROM pg_policies
        WHERE schemaname = 'public'
      ) t
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.config_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.config_snapshot() TO service_role;

COMMENT ON FUNCTION public.config_snapshot() IS
  'issue #757 の 35。設定ドリフト検知が読む、public スキーマの権限とポリシーの一覧。service_role のみ。';
