-- supabase/migrations/20260907000002_add_access_denials.sql
-- issue #757 の 24（監査証跡の完全性）の残りのうち、アプリ境界で拒否された操作の記録。
-- 約束カタログ P-063。
-- release-order: db-first
-- design: 2026-09-07 に人へ聞いて決めた答え（docs/agents/design-questions.md）。
--   大きさ: 1 行は guard/reason が固定語、route は 200 文字まで（クエリ文字列は落とす）。
--   量: 拒否は連続で起きる。1 施設あたり数万行を想定し、時刻の索引で新しい順に読む。
--   権限: 読めるのは admin のみ（aal2 必須）。書けるのは service_role だけ（RPC 経由）。
--   消えるとき: 消えない（append-only）。施設が消えても記録は残す（証跡のため facility_id は
--               外部キーを張らない）。保存期間の方針は #757 の 25 で決める。
--   記録: これ自体が「失敗した操作」の記録。成功は audit_log 側。
--   途中で止まったら: 記録の失敗はリクエストを止めない（拒否は fail-closed、記録だけ fail-open）。
--   外に出るもの: なし。
--
-- WHY: audit_log（20260906000004）は「起きた変更」しか残さない。拒否された操作は行トリガーに
--      来ないので、誰が何を試して弾かれたかが 1 件も残っていなかった。乗っ取りの兆候
--      （他施設 ID の総当たり・admin 画面への繰り返しアクセス）は、成功した操作ではなく
--      **失敗した操作の並び**にしか現れない。
--
--      記録はアプリの認可ガード（requireAuth / requireFacilityAccess / requireAdmin）から行う。
--      RLS が黙って 0 件を返す経路と proxy 段の拒否はここに来ない（既知の限界。下記）。
--
-- WHY(RPC 経由で書く): 書き手は Next.js のサーバー（service_role）だが、テーブルへ直接
--      INSERT 権限を渡すと「監査対象のロールが監査表を自由に書ける」状態になる。
--      SECURITY DEFINER の record_access_denial() だけを service_role に GRANT し、
--      列と値の形は関数側で固定する。anon / authenticated には EXECUTE を渡さない
--      （渡すと誰でも偽の拒否記録を大量に作れる。#757-32）。
--
-- WHY(append-only): audit_log と同じ。client は SELECT のみ、service_role でも
--      UPDATE / DELETE / TRUNCATE をトリガーで拒否する。
--
-- WHY(route / method): Route Handler は自分のパスを知る手段を持たないので、proxy.ts が
--      転送リクエストへ x-aidd-route / x-aidd-method を付け（クライアントの値は必ず上書き）、
--      記録ヘルパーがそれを読む。src/lib/security/denial-headers.ts が名前の正本。
--
-- 既知の限界（#757 の 24 に残す）:
--   - RLS で「見えない」ことによる拒否（SELECT が 0 件、UPDATE が 0 行）はアプリから区別できず、
--     ここに来ない。PostgREST / Supabase のログ側で扱う
--   - 画面（Server Component）からの読み取りは API Route を通らないので記録されない
--   - proxy が admin パスを /login へ返す経路は未記録（Edge Runtime に service role を持ち込まない
--     判断のため。guard = 'proxy_admin' は将来のために予約してある）
--   - 記録に失敗してもリクエストは通常どおり拒否される（記録のためにサービスを止めない。fail-open だが
--     「拒否そのもの」は fail-closed のまま。docs/agents/fail-open-inventory.md の型）
--
-- ROLLBACK:
--   DROP TRIGGER access_denials_no_truncate ON access_denials;
--   DROP TRIGGER access_denials_no_update_delete ON access_denials;
--   DROP FUNCTION access_denials_immutable();
--   DROP FUNCTION record_access_denial(TEXT, TEXT, TEXT, TEXT, UUID, UUID);
--   DROP TABLE access_denials;
--   SELECT refresh_schema_baseline_snapshot('<この migration より前のタイムスタンプ>');

-- 1. テーブル
CREATE TABLE access_denials (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  guard       TEXT NOT NULL CHECK (guard IN ('auth', 'facility', 'admin', 'proxy_admin')),
  reason      TEXT NOT NULL CHECK (reason IN ('unauthenticated', 'facility_id_required', 'forbidden', 'not_admin')),
  route       TEXT,
  method      TEXT,
  actor_id    UUID,
  facility_id UUID
);
-- actor_id / facility_id に FK を張らない: 利用者や施設が消えても証跡は残す（audit_log と同じ）
CREATE INDEX access_denials_occurred_idx ON access_denials (occurred_at DESC);
CREATE INDEX access_denials_actor_idx ON access_denials (actor_id, occurred_at DESC);

-- 2. RLS: 読めるのは aal2 まで上げた admin だけ（誰がどこを叩いたかは admin 以外に見せない）
ALTER TABLE access_denials ENABLE ROW LEVEL SECURITY;
CREATE POLICY access_denials_select ON access_denials
  FOR SELECT TO authenticated
  USING (is_admin() AND has_aal2());

REVOKE ALL ON TABLE access_denials FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE access_denials TO authenticated, service_role;

-- 3. 記録する唯一の入口（service_role だけが呼べる）
-- WHY(DEFAULT NULL): 経路や施設が分からない拒否（未認証など）もあるので、guard と reason 以外は
--      省略できるようにする。生成される TypeScript の型も省略可になり、呼び出し側で null を
--      無理に渡さずに済む（supabase gen types は DEFAULT の有無で必須・任意を決める）。
CREATE OR REPLACE FUNCTION record_access_denial(
  p_guard       TEXT,
  p_reason      TEXT,
  p_route       TEXT DEFAULT NULL,
  p_method      TEXT DEFAULT NULL,
  p_actor_id    UUID DEFAULT NULL,
  p_facility_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.access_denials (guard, reason, route, method, actor_id, facility_id)
  VALUES (
    p_guard,
    p_reason,
    -- WHY: route はクエリ文字列を落としてパスだけ残す（施設 ID や検索語が入るため。#757-5）
    split_part(COALESCE(p_route, ''), '?', 1),
    p_method,
    p_actor_id,
    p_facility_id
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION record_access_denial(TEXT, TEXT, TEXT, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_access_denial(TEXT, TEXT, TEXT, TEXT, UUID, UUID) TO service_role;

-- 4. append-only（service_role でも消せない）
CREATE OR REPLACE FUNCTION access_denials_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'access_denials is append-only (% is not allowed)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER access_denials_no_update_delete
  BEFORE UPDATE OR DELETE ON access_denials
  FOR EACH ROW EXECUTE FUNCTION access_denials_immutable();
CREATE TRIGGER access_denials_no_truncate
  BEFORE TRUNCATE ON access_denials
  FOR EACH STATEMENT EXECUTE FUNCTION access_denials_immutable();

-- 5. スキーマドリフト検知の baseline を更新する（テーブル追加のため必須。.claude/rules/db-schema.md）
SELECT refresh_schema_baseline_snapshot('20260907000002');
