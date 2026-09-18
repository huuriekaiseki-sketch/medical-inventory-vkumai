-- supabase/migrations/20260907050000_add_privileged_operations.sql
-- lock: 新設した表への CREATE INDEX なので、既存の業務表は一切ロックしない（作った直後で 0 行）
-- issue #757 の 24・39。特権操作（Supabase Auth の管理 API）の**成功**の記録。
-- 特権書き込みルールブック W-011 の限界のうち「auth.users の作成・削除が監査ログに残らない」を塞ぐ。
-- release-order: db-first
-- design: 2026-09-07 に人へ聞いて決めた答え（docs/agents/design-questions.md）。
--   記録先: 新しい表（audit_log には入れない。理由は下の WHY）。
--   PII: 対象利用者のメールを**残す**。読めるのは aal2 まで上げた admin だけ。
--   大きさ: operation は固定語、route は 200 文字まで、メールは 254 文字まで（RFC の上限）。
--   量: admin の手作業なので 1 日に数件〜数十件。時刻の索引で新しい順に読む。
--   権限: 読めるのは admin のみ（aal2 必須）。書けるのは service_role だけ（RPC 経由）。
--   消えるとき: 消えない（append-only）。利用者が消えても記録は残す（FK を張らない）。
--   途中で止まったら: 記録の失敗は操作を止めない（記録だけ fail-open）。
--   外に出るもの: なし。
--
-- WHY: 2026-09-07 の点検で、`src/app/api/admin/users/route.ts` が
--      `inviteUserByEmail` / `deleteUser` を呼んでいるのに、**成功時に何も記録していなかった**。
--      拒否された分だけが access_denials に残り、**通った分は 1 件も残らない**という非対称な状態で、
--      「誰がいつ利用者を招待・削除したか」がアプリ側から一切追えなかった。
--
--      audit_log（20260906000004）は public スキーマの行トリガーで残す仕組みなので、
--      GoTrue が管理する auth.users は対象外。トリガーでは届かない。
--
-- WHY(audit_log に相乗りしない): audit_log は「行の変更をトリガーが**自動で**残す表」で、
--      監査の完全性テスト（audit-completeness）は「16 表 × 3 操作でちょうど 1 行」を数えている。
--      アプリが手で書く行を混ぜると、その前提（全行がトリガー由来）が崩れる。
--      拒否は access_denials、変更は audit_log、特権操作は本表、と入口を分ける。
--
-- WHY(メールを残す): 招待は**まだ存在しない相手**へ送るので、利用者 ID が無い。
--      メールを落とすと「誰に招待を送ったか」が永久に分からず、招待の乱用（外部への大量送信）を
--      後から調べられない。PII なので RLS で admin のみに絞り、
--      **サーバーログには出さない**（log-safe.ts の伏せ字はメールを [email] にするので、
--      DB には残るがログには出ない、という分け方になる）。
--
-- WHY(成功も失敗も残す): 失敗だけ残すと「試したが通らなかった」しか見えず、
--      乗っ取り後に**成功した**操作の範囲が分からない。succeeded 列で両方を 1 表に入れる。
--
-- WHY(SECURITY DEFINER に認可判定を持たせない): record_privileged_operation() は関数の中で
--      is_admin() 等を確かめない。理由は 3 つで、record_access_denial() と同じ判断:
--        1. **EXECUTE を service_role にしか渡していない**（anon / authenticated は明示 REVOKE）。
--           呼べるのは Next.js のサーバーだけで、そこは requireAdmin + assertAdminAal2 を
--           通った後にしか呼ばない（W-011）。
--        2. **この関数は読み取りをしない。** できるのは自表への 1 行 INSERT だけで、
--           業務データにも auth スキーマにも触れない。認可をすり抜けて取れる情報が無い。
--        3. **関数の中で is_admin() を見ると逆に壊れる。** SECURITY DEFINER は定義者の権限で
--           動くので auth.uid() は呼び出し元の JWT を指さない。service_role からの呼び出しでは
--           常に偽になり、記録が一切残らなくなる（fail-open ではなく「機能しない」形）。
--      **残るリスク**: service role キーが漏れた場合、偽の記録を作れる。ただしその状況では
--      Auth の管理 API そのものが直接叩けるので、この関数が増やすリスクは無い（blast-radius B-010）。
--
-- 既知の限界（#757 の 24 に残す）:
--   - **Supabase Studio や service role キーを直に使った auth.users の操作はここに来ない。**
--     記録するのはこのアプリの route を通った分だけ（blast-radius の B-010 と同じ範囲）
--   - **記録と Auth 操作は 1 つのトランザクションに入らない。** Auth API は SQL の外なので、
--     「Auth は成功したが記録は失敗した」が起こりうる（記録だけ fail-open。W-011 の限界と同型）
--   - MFA の登録・解除、パスワード再設定は現時点でこの route を通らないので対象外
--
-- ROLLBACK:
--   DROP TRIGGER privileged_operations_no_truncate ON privileged_operations;
--   DROP TRIGGER privileged_operations_no_update_delete ON privileged_operations;
--   DROP FUNCTION privileged_operations_immutable();
--   DROP FUNCTION record_privileged_operation(TEXT, BOOLEAN, UUID, TEXT, UUID, TEXT, TEXT, TEXT);
--   DROP TABLE privileged_operations;
--   SELECT refresh_schema_baseline_snapshot('<この migration より前のタイムスタンプ>');

-- 1. テーブル
CREATE TABLE privileged_operations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 固定語彙。自由文字列にすると後から数えられなくなる（denial reason と同じ判断）
  operation      TEXT NOT NULL CHECK (operation IN ('user_invite', 'user_delete')),
  succeeded      BOOLEAN NOT NULL,
  actor_id       UUID NOT NULL,
  target_user_id UUID,
  target_email   TEXT CHECK (target_email IS NULL OR length(target_email) <= 254),
  -- 失敗したときだけ入る。PostgREST / GoTrue の code をそのまま（本文は入れない）
  error_code     TEXT CHECK (error_code IS NULL OR length(error_code) <= 100),
  route          TEXT CHECK (route IS NULL OR length(route) <= 200),
  method         TEXT CHECK (method IS NULL OR length(method) <= 10)
);
-- actor_id / target_user_id に FK を張らない: 利用者が消えても証跡は残す（access_denials と同じ）
CREATE INDEX privileged_operations_occurred_idx ON privileged_operations (occurred_at DESC);
CREATE INDEX privileged_operations_actor_idx ON privileged_operations (actor_id, occurred_at DESC);

-- 2. RLS: 読めるのは aal2 まで上げた admin だけ（メールを含むため access_denials より厳しくはしない
--    が、同じ強さは要る）
ALTER TABLE privileged_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY privileged_operations_select ON privileged_operations
  FOR SELECT TO authenticated
  USING (is_admin() AND has_aal2());

REVOKE ALL ON TABLE privileged_operations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE privileged_operations TO authenticated, service_role;

-- 3. 記録する唯一の入口（service_role だけが呼べる）
CREATE OR REPLACE FUNCTION record_privileged_operation(
  p_operation      TEXT,
  p_succeeded      BOOLEAN,
  p_actor_id       UUID,
  p_target_email   TEXT DEFAULT NULL,
  p_target_user_id UUID DEFAULT NULL,
  p_error_code     TEXT DEFAULT NULL,
  p_route          TEXT DEFAULT NULL,
  p_method         TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.privileged_operations
    (operation, succeeded, actor_id, target_email, target_user_id, error_code, route, method)
  VALUES (
    p_operation,
    p_succeeded,
    p_actor_id,
    p_target_email,
    p_target_user_id,
    p_error_code,
    -- route はクエリ文字列を落としてパスだけ残す（access_denials と同じ。#757-5）
    NULLIF(split_part(COALESCE(p_route, ''), '?', 1), ''),
    p_method
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION record_privileged_operation(TEXT, BOOLEAN, UUID, TEXT, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_privileged_operation(TEXT, BOOLEAN, UUID, TEXT, UUID, TEXT, TEXT, TEXT)
  TO service_role;

-- 4. append-only（service_role でも消せない）
CREATE OR REPLACE FUNCTION privileged_operations_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'privileged_operations is append-only (% is not allowed)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER privileged_operations_no_update_delete
  BEFORE UPDATE OR DELETE ON privileged_operations
  FOR EACH ROW EXECUTE FUNCTION privileged_operations_immutable();
CREATE TRIGGER privileged_operations_no_truncate
  BEFORE TRUNCATE ON privileged_operations
  FOR EACH STATEMENT EXECUTE FUNCTION privileged_operations_immutable();

-- 5. スキーマドリフト検知の baseline を更新する（テーブル追加のため必須。.claude/rules/db-schema.md）
SELECT refresh_schema_baseline_snapshot('20260907050000');
