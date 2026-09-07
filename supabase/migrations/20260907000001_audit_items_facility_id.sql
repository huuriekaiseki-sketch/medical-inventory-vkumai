-- supabase/migrations/20260907000001_audit_items_facility_id.sql
-- issue #757 の 24（監査証跡の完全性）。約束カタログ P-060 / P-062。
--
-- WHY: 明細（*_items）の監査行が、その施設の人に 1 件も見えていなかった。
--      audit_log の SELECT ポリシーは
--        is_admin() OR (facility_id IS NOT NULL AND is_facility_member(facility_id))
--      で、明細テーブルは facility_id 列を持たないため監査行の facility_id が null になり、
--      全体管理者だけが読める状態だった（2026-09-07 に
--      supabase/__tests__/integration/audit-completeness.integration.test.ts で実測）。
--      「何を何個頼んだか」はまさに明細側にあるので、施設の人が自分の施設の変更履歴を
--      追えないのは監査ログとして用を成していない。
--
-- 直し方: 行に facility_id が無いときだけ、**親をたどって引く**。
--      どの親のどの列かはトリガー作成時の引数（TG_ARGV）で渡す。関数の中に
--      表ごとの分岐を書くと、そこがまた手書きの一覧（＝ズレの発生源）になるため。
--
-- 既知の限界（あえて残す）: 親ごとカスケード削除されたときは、親の行が先に消えてから
--      子の AFTER DELETE が走るので引けず、facility_id は null のまま残る。
--      その場合でも「親の DELETE 監査行」には facility_id が入るので、
--      施設の人は「その発注が消えた」ことは追える。明細を 1 件ずつ消す通常の経路
--      （アプリの操作）では親が残っているので引ける。
--
-- ROLLBACK: 20260906000004 の audit_row_change() 定義で CREATE OR REPLACE し直し、
--           下の 4 つのトリガーを引数なしで作り直す。

CREATE OR REPLACE FUNCTION audit_row_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old      JSONB;
  v_new      JSONB;
  v_row      JSONB;
  v_changed  TEXT[];
  v_claims   JSONB;
  v_facility UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;
  v_row := COALESCE(v_new, v_old);

  IF TG_OP = 'UPDATE' THEN
    -- updated_at は BEFORE UPDATE トリガーが毎回 now() にする派生値なので差分から除く
    SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
    FROM jsonb_each(v_new) AS n
    WHERE n.key <> 'updated_at' AND v_old -> n.key IS DISTINCT FROM n.value;
    -- 値の変わらない UPDATE は記録しない
    IF v_changed IS NULL THEN RETURN NULL; END IF;
  END IF;

  v_facility := (v_row ->> 'facility_id')::uuid;

  -- 自分が facility_id を持たない表（明細など）は、引数で渡された親からたどる。
  -- 親が既に消えている（カスケード削除）場合は引けないので null のままにする。
  IF v_facility IS NULL AND TG_NARGS = 2 AND (v_row ->> TG_ARGV[1]) IS NOT NULL THEN
    EXECUTE format('SELECT facility_id FROM public.%I WHERE id = $1', TG_ARGV[0])
      INTO v_facility
      USING (v_row ->> TG_ARGV[1])::uuid;
  END IF;

  v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;

  INSERT INTO public.audit_log (table_name, row_id, facility_id, action, actor_id, actor_role, old_data, new_data, changed_columns)
  VALUES (
    TG_TABLE_NAME,
    (v_row ->> 'id')::uuid,
    v_facility,
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

-- 明細の 4 表だけ、親の情報を渡して付け直す（他の表は引数なしのまま動く）
DROP TRIGGER case_order_items_audit ON case_order_items;
CREATE TRIGGER case_order_items_audit
  AFTER INSERT OR UPDATE OR DELETE ON case_order_items
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('case_orders', 'case_order_id');

DROP TRIGGER consumable_order_items_audit ON consumable_order_items;
CREATE TRIGGER consumable_order_items_audit
  AFTER INSERT OR UPDATE OR DELETE ON consumable_order_items
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('consumable_orders', 'consumable_order_id');

DROP TRIGGER loan_order_items_audit ON loan_order_items;
CREATE TRIGGER loan_order_items_audit
  AFTER INSERT OR UPDATE OR DELETE ON loan_order_items
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('loan_orders', 'loan_order_id');

DROP TRIGGER loan_return_items_audit ON loan_return_items;
CREATE TRIGGER loan_return_items_audit
  AFTER INSERT OR UPDATE OR DELETE ON loan_return_items
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('loan_returns', 'loan_return_id');
