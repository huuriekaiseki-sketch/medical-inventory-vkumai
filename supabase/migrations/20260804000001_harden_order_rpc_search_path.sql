-- supabase/migrations/20260804000001_harden_order_rpc_search_path.sql
-- ハンズオン: search_path hijacking対策として、発注系RPC 4関数の
-- SET search_path = public を SET search_path = '' に変更し、
-- 参照するテーブル・%ROWTYPE・他関数呼び出しをすべて public. で完全修飾する。
-- WHY: SECURITY DEFINER関数はsearch_path=publicのままだと、呼び出し元が
--      public以外のスキーマに同名オブジェクトを仕込んでいた場合に解決順序が
--      影響を受ける余地が残る。search_path=''にして全参照を完全修飾すれば、
--      名前解決が常に固定され、乗っ取りの余地がなくなる。
-- WHY(既存migrationは追記・修正禁止): 20260715000002で定義済みの4関数を
--      CREATE OR REPLACE FUNCTIONで再定義する。列・ロジックは変更しない。

CREATE OR REPLACE FUNCTION resolve_jan_unit_price(
  p_jan TEXT,
  p_facility_id UUID
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT MIN(hp.purchase_price)
  FROM public.products p
  JOIN public.distributor_products dp ON dp.product_id = p.id
  JOIN public.hospital_prices hp
    ON hp.distributor_product_id = dp.id
   AND hp.facility_id = p_facility_id
  WHERE p.jan = p_jan
$$;

-- 症例発注
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
  IF NOT public.is_facility_member(p_facility_id) THEN
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

-- 短貸発注
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
  IF NOT public.is_facility_member(p_facility_id) THEN
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

-- 消耗品発注
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
  IF NOT public.is_facility_member(p_facility_id) THEN
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
