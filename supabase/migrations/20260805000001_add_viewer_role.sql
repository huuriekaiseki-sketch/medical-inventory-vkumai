-- supabase/migrations/20260805000001_add_viewer_role.sql
-- WHY: RBAC拡張のハンズオン。user_facilities.roleに'viewer'を追加し、
--      「書き込み全般不可・閲覧のみ」というシンプルな定義で運用する
--      （施設ごとの細かい操作単位での権限分けはしない）。
--      is_admin()はrole='admin'の等価比較のみで判定しているため、
--      viewer追加によるis_admin()自体のロジック変更は不要。

-- =========================================================================
-- 1. role CHECK制約にviewerを追加
-- =========================================================================
ALTER TABLE user_facilities DROP CONSTRAINT user_facilities_role_check;
ALTER TABLE user_facilities
  ADD CONSTRAINT user_facilities_role_check
  CHECK (role IN ('staff', 'admin', 'viewer'));

-- =========================================================================
-- 2. is_facility_writer() ヘルパー関数
--    is_facility_member()と同じ施設所属チェックに加え、role='viewer'では
--    falseを返す。is_admin()は別途ORで組み合わせて使う(既存のfacility_
--    member_or_adminパターンと同じ構成)。
-- =========================================================================
CREATE OR REPLACE FUNCTION is_facility_writer(p_facility_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_facilities
    WHERE user_id = auth.uid() AND facility_id = p_facility_id AND role IN ('staff', 'admin')
  );
$$;

-- =========================================================================
-- 3. RLS: FOR ALLだった書き込み系ポリシーをSELECT(member)とALL(writer)に分割
--    SELECTポリシーとALLポリシーは permissive(OR結合) のため、
--    SELECT時は member_or_admin(=旧来通り) OR writer_or_admin の合成となり
--    実質member_or_adminのまま。INSERT/UPDATE/DELETEはALLポリシーのみが
--    マッチするため writer_or_admin に限定される。
-- =========================================================================
DROP POLICY IF EXISTS "facility_member_or_admin" ON consumable_orders;
CREATE POLICY "facility_member_or_admin" ON consumable_orders
  FOR SELECT TO authenticated
  USING (is_facility_member(facility_id) OR is_admin());
CREATE POLICY "facility_writer_or_admin" ON consumable_orders
  FOR ALL TO authenticated
  USING (is_facility_writer(facility_id) OR is_admin())
  WITH CHECK (is_facility_writer(facility_id) OR is_admin());

DROP POLICY IF EXISTS "facility_member_or_admin" ON case_orders;
CREATE POLICY "facility_member_or_admin" ON case_orders
  FOR SELECT TO authenticated
  USING (is_facility_member(facility_id) OR is_admin());
CREATE POLICY "facility_writer_or_admin" ON case_orders
  FOR ALL TO authenticated
  USING (is_facility_writer(facility_id) OR is_admin())
  WITH CHECK (is_facility_writer(facility_id) OR is_admin());

DROP POLICY IF EXISTS "facility_member_or_admin" ON loan_orders;
CREATE POLICY "facility_member_or_admin" ON loan_orders
  FOR SELECT TO authenticated
  USING (is_facility_member(facility_id) OR is_admin());
CREATE POLICY "facility_writer_or_admin" ON loan_orders
  FOR ALL TO authenticated
  USING (is_facility_writer(facility_id) OR is_admin())
  WITH CHECK (is_facility_writer(facility_id) OR is_admin());

DROP POLICY IF EXISTS "facility_member_or_admin" ON loan_returns;
CREATE POLICY "facility_member_or_admin" ON loan_returns
  FOR SELECT TO authenticated
  USING (is_facility_member(facility_id) OR is_admin());
CREATE POLICY "facility_writer_or_admin" ON loan_returns
  FOR ALL TO authenticated
  USING (is_facility_writer(facility_id) OR is_admin())
  WITH CHECK (is_facility_writer(facility_id) OR is_admin());

DROP POLICY IF EXISTS "facility_member_or_admin" ON hospital_prices;
CREATE POLICY "facility_member_or_admin" ON hospital_prices
  FOR SELECT TO authenticated
  USING (is_facility_member(facility_id) OR is_admin());
CREATE POLICY "facility_writer_or_admin" ON hospital_prices
  FOR ALL TO authenticated
  USING (is_facility_writer(facility_id) OR is_admin())
  WITH CHECK (is_facility_writer(facility_id) OR is_admin());

DROP POLICY IF EXISTS "facility_member_or_admin" ON consumables;
CREATE POLICY "facility_member_or_admin" ON consumables
  FOR SELECT TO authenticated
  USING (is_facility_member(facility_id) OR is_admin());
CREATE POLICY "facility_writer_or_admin" ON consumables
  FOR ALL TO authenticated
  USING (is_facility_writer(facility_id) OR is_admin())
  WITH CHECK (is_facility_writer(facility_id) OR is_admin());

-- facilities（UPDATEのみwriter化。SELECT/INSERTは既存のまま）
DROP POLICY IF EXISTS "facility_member_or_admin_update" ON facilities;
CREATE POLICY "facility_writer_or_admin_update" ON facilities
  FOR UPDATE TO authenticated
  USING (is_facility_writer(id) OR is_admin())
  WITH CHECK (is_facility_writer(id) OR is_admin());

-- items テーブル（親order経由。同じSELECT/ALL分割パターン）
DROP POLICY IF EXISTS "facility_member_or_admin" ON case_order_items;
CREATE POLICY "facility_member_or_admin" ON case_order_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM case_orders o
    WHERE o.id = case_order_items.case_order_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ));
CREATE POLICY "facility_writer_or_admin" ON case_order_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM case_orders o
    WHERE o.id = case_order_items.case_order_id
      AND (is_facility_writer(o.facility_id) OR is_admin())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM case_orders o
    WHERE o.id = case_order_items.case_order_id
      AND (is_facility_writer(o.facility_id) OR is_admin())
  ));

DROP POLICY IF EXISTS "facility_member_or_admin" ON consumable_order_items;
CREATE POLICY "facility_member_or_admin" ON consumable_order_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM consumable_orders o
    WHERE o.id = consumable_order_items.consumable_order_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ));
CREATE POLICY "facility_writer_or_admin" ON consumable_order_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM consumable_orders o
    WHERE o.id = consumable_order_items.consumable_order_id
      AND (is_facility_writer(o.facility_id) OR is_admin())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM consumable_orders o
    WHERE o.id = consumable_order_items.consumable_order_id
      AND (is_facility_writer(o.facility_id) OR is_admin())
  ));

DROP POLICY IF EXISTS "facility_member_or_admin" ON loan_order_items;
CREATE POLICY "facility_member_or_admin" ON loan_order_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM loan_orders o
    WHERE o.id = loan_order_items.loan_order_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ));
CREATE POLICY "facility_writer_or_admin" ON loan_order_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM loan_orders o
    WHERE o.id = loan_order_items.loan_order_id
      AND (is_facility_writer(o.facility_id) OR is_admin())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM loan_orders o
    WHERE o.id = loan_order_items.loan_order_id
      AND (is_facility_writer(o.facility_id) OR is_admin())
  ));

DROP POLICY IF EXISTS "facility_member_or_admin" ON loan_return_items;
CREATE POLICY "facility_member_or_admin" ON loan_return_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM loan_returns o
    WHERE o.id = loan_return_items.loan_return_id
      AND (is_facility_member(o.facility_id) OR is_admin())
  ));
CREATE POLICY "facility_writer_or_admin" ON loan_return_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM loan_returns o
    WHERE o.id = loan_return_items.loan_return_id
      AND (is_facility_writer(o.facility_id) OR is_admin())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM loan_returns o
    WHERE o.id = loan_return_items.loan_return_id
      AND (is_facility_writer(o.facility_id) OR is_admin())
  ));

-- =========================================================================
-- 4. 発注/返却系RPCの認可チェックをis_facility_memberからis_facility_writer
--    へ変更する。既存migrationは追記・修正禁止のため、CREATE OR REPLACE
--    FUNCTIONで再定義する(列・ロジックは変更しない、認可チェックのみ変更)。
--    resolve_jan_unit_priceは読み取り専用ヘルパーのため対象外。
-- =========================================================================
CREATE OR REPLACE FUNCTION create_case_order_atomic(
  p_facility_id UUID,
  p_case_datetime TIMESTAMPTZ,
  p_procedure_name TEXT,
  p_patient_id TEXT,
  p_patient_initials TEXT,
  p_gender TEXT,
  p_doctor_name TEXT,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.case_orders%ROWTYPE;
  v_items JSONB;
BEGIN
  IF NOT public.is_facility_writer(p_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;

  INSERT INTO public.case_orders (
    facility_id, case_datetime, procedure_name,
    patient_id, patient_initials, gender, doctor_name
  ) VALUES (
    p_facility_id, p_case_datetime, p_procedure_name,
    p_patient_id, p_patient_initials, p_gender, p_doctor_name
  )
  RETURNING * INTO v_order;

  INSERT INTO public.case_order_items (case_order_id, jan, lot, ubd, quantity, unit_price)
  SELECT
    v_order.id,
    elem->>'jan',
    elem->>'lot',
    elem->>'ubd',
    COALESCE((elem->>'quantity')::INTEGER, 1),
    public.resolve_jan_unit_price(elem->>'jan', p_facility_id)
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM public.case_order_items i
  WHERE i.case_order_id = v_order.id;

  RETURN to_jsonb(v_order) || jsonb_build_object('items', v_items);
END;
$$;

CREATE OR REPLACE FUNCTION create_loan_order_atomic(
  p_facility_id UUID,
  p_procedure_name TEXT,
  p_maker TEXT,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.loan_orders%ROWTYPE;
  v_items JSONB;
BEGIN
  IF NOT public.is_facility_writer(p_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;

  INSERT INTO public.loan_orders (facility_id, procedure_name, maker)
  VALUES (p_facility_id, p_procedure_name, p_maker)
  RETURNING * INTO v_order;

  INSERT INTO public.loan_order_items (loan_order_id, jan, name, quantity, unit_price)
  SELECT
    v_order.id,
    elem->>'jan',
    elem->>'name',
    COALESCE((elem->>'quantity')::INTEGER, 1),
    public.resolve_jan_unit_price(elem->>'jan', p_facility_id)
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM public.loan_order_items i
  WHERE i.loan_order_id = v_order.id;

  RETURN to_jsonb(v_order) || jsonb_build_object('items', v_items);
END;
$$;

CREATE OR REPLACE FUNCTION create_consumable_order_atomic(
  p_facility_id UUID,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.consumable_orders%ROWTYPE;
  v_items JSONB;
BEGIN
  IF NOT public.is_facility_writer(p_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;

  INSERT INTO public.consumable_orders (facility_id)
  VALUES (p_facility_id)
  RETURNING * INTO v_order;

  INSERT INTO public.consumable_order_items (consumable_order_id, consumable_id, quantity, unit_price)
  SELECT
    v_order.id,
    (elem->>'consumable_id')::UUID,
    COALESCE((elem->>'quantity')::INTEGER, 1),
    (
      SELECT public.resolve_jan_unit_price(c.jan, p_facility_id)
      FROM public.consumables c
      WHERE c.id = (elem->>'consumable_id')::UUID
    )
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM public.consumable_order_items i
  WHERE i.consumable_order_id = v_order.id;

  RETURN to_jsonb(v_order) || jsonb_build_object('items', v_items);
END;
$$;

CREATE OR REPLACE FUNCTION create_loan_return_atomic(
  p_header JSONB,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_facility_id UUID := (p_header->>'facility_id')::UUID;
  v_loan_order_id UUID := NULLIF(p_header->>'loan_order_id', '')::UUID;
  v_return public.loan_returns%ROWTYPE;
  v_items JSONB;
BEGIN
  IF NOT public.is_facility_writer(v_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;

  INSERT INTO public.loan_returns (facility_id, return_datetime, loan_order_id)
  VALUES (v_facility_id, (p_header->>'return_datetime')::TIMESTAMPTZ, v_loan_order_id)
  RETURNING * INTO v_return;

  INSERT INTO public.loan_return_items (loan_return_id, jan, lot, ubd, quantity)
  SELECT
    v_return.id,
    elem->>'jan',
    elem->>'lot',
    elem->>'ubd',
    COALESCE((elem->>'quantity')::INTEGER, 1)
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM public.loan_return_items i
  WHERE i.loan_return_id = v_return.id;

  RETURN to_jsonb(v_return) || jsonb_build_object('items', v_items);
END;
$$;
