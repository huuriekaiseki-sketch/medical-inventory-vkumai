-- supabase/migrations/20260906000004_add_audit_log.sql
-- issue #757 の 4（監査ログと改ざん検知）と 24（監査証跡の完全性）の DB 側。約束カタログ P-060〜P-062。
--
-- WHY: 「誰がいつ何を変えたか」は price_histories（価格だけ）にしか残っておらず、発注・返却・所属
--      （権限）・マスタの変更は追えなかった。API Route を通らない経路（RPC 直接呼び出し、service_role、
--      Studio、migration の UPDATE）でも必ず残るよう、アプリではなく行トリガーで記録する。
--      記録は SECURITY DEFINER で audit_log に書くので、書き手のロールに INSERT 権限を与えない。
--
-- WHY(append-only): 監査ログは「消せない・書き換えられない」ことが価値。client ロールには SELECT 以外の
--      ポリシーを作らず、GRANT も SELECT だけにする。service_role は RLS を通らないので、UPDATE /
--      DELETE / TRUNCATE をトリガーで拒否する（postgres の superuser がトリガーを落とせば消せるが、
--      それは migration 経由でしか起きず、スキーマドリフト検知 #305 の対象）。Supabase の既定権限
--      （ALTER DEFAULT PRIVILEGES）は anon / authenticated / service_role に ALL を付けるので、
--      REVOKE を 3 ロールとも明示する（known-failure-patterns「GRANT を書いていない＝呼べない」）。
--
-- 記録しないもの: price_histories（価格の履歴として既に append-only）、schema_drift_*（監視の裏方）、
--      audit_log 自身。拒否された操作（RLS で弾かれた SELECT / INSERT）はトリガーに来ないので
--      ここでは記録できない（#757 の 24 の残り。PostgREST のログ側で扱う）。

-- 1. テーブル
CREATE TABLE audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  table_name      TEXT NOT NULL,
  row_id          UUID,
  facility_id     UUID,
  action          TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  actor_id        UUID,
  actor_role      TEXT NOT NULL,
  old_data        JSONB,
  new_data        JSONB,
  changed_columns TEXT[]
);
-- facility_id / row_id に FK を張らない: 元の行や施設が消えても監査行は残す
CREATE INDEX audit_log_facility_occurred_idx ON audit_log (facility_id, occurred_at DESC);
CREATE INDEX audit_log_table_row_idx ON audit_log (table_name, row_id);

-- 2. RLS: 読むのは admin か、その施設のメンバーだけ。書き込み系のポリシーは作らない（= client は拒否）
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_select ON audit_log
  FOR SELECT TO authenticated
  USING (is_admin() OR (facility_id IS NOT NULL AND is_facility_member(facility_id)));

REVOKE ALL ON TABLE audit_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE audit_log TO authenticated, service_role;

-- 3. append-only（service_role でも消せない）
CREATE OR REPLACE FUNCTION audit_log_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% is not allowed)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- 4. 記録トリガー（SECURITY DEFINER。RETURNS TRIGGER なので RPC としては公開されない）
CREATE OR REPLACE FUNCTION audit_row_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old     JSONB;
  v_new     JSONB;
  v_row     JSONB;
  v_changed TEXT[];
  v_claims  JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;
  v_row := COALESCE(v_new, v_old);

  IF TG_OP = 'UPDATE' THEN
    -- updated_at は BEFORE UPDATE トリガーが毎回 now() にする派生値なので差分から除く。
    -- 除かないと同値 UPDATE でも changed_columns = {updated_at} になり、ノイズが残る（実測で踏んだ）
    SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
    FROM jsonb_each(v_new) AS n
    WHERE n.key <> 'updated_at' AND v_old -> n.key IS DISTINCT FROM n.value;
    -- 値の変わらない UPDATE は記録しない
    IF v_changed IS NULL THEN RETURN NULL; END IF;
  END IF;

  v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;

  INSERT INTO public.audit_log (table_name, row_id, facility_id, action, actor_id, actor_role, old_data, new_data, changed_columns)
  VALUES (
    TG_TABLE_NAME,
    (v_row ->> 'id')::uuid,
    (v_row ->> 'facility_id')::uuid,
    TG_OP,
    auth.uid(),
    COALESCE(v_claims ->> 'role', session_user::text),
    v_old,
    v_new,
    v_changed
  );
  RETURN NULL;
END;
$$;

-- 5. 施設スコープの業務データ・所属（権限）・マスタに付ける
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'case_orders', 'case_order_items',
    'consumable_orders', 'consumable_order_items',
    'loan_orders', 'loan_order_items',
    'loan_returns', 'loan_return_items',
    'consumables', 'hospital_prices',
    'user_facilities', 'facilities',
    'products', 'distributor_products', 'categories', 'product_compatibilities'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      t || '_audit', t
    );
  END LOOP;
END $$;

-- ROLLBACK:
--   各表の <table>_audit トリガーを DROP → DROP FUNCTION audit_row_change() →
--   DROP TABLE audit_log（immutable トリガーごと消える）→ refresh_schema_baseline_snapshot を再実行

-- テーブル新設のため baseline snapshot を更新する（.claude/rules/db-schema.md）
SELECT refresh_schema_baseline_snapshot('20260906000004');
