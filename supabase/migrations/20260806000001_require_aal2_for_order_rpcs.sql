-- supabase/migrations/20260806000001_require_aal2_for_order_rpcs.sql
-- WHY: #600でTOTP MFAを追加したが、aal2への昇格強制はsrc/middleware.tsのみで
--      行っており、RLS/RPC側はAALを一切見ていなかった(issue #612)。
--      SupabaseのanonキーとプロジェクトURLはブラウザに公開されており、ログイン
--      済みユーザーは自分のアクセストークンを使ってNext.jsアプリを経由せず直接
--      SupabaseのREST/RPCエンドポイントを呼び出せる。つまりmiddlewareは正規ルートの
--      UX誘導であり、DB層(RLS/RPC)こそが唯一の実効的なセキュリティ境界となる。
--      発注・返却は在庫変動と金額を伴う操作のため、aal1のまま(MFA未完了)で
--      直接叩かれても実行できないようDB側で独立に強制する。
--      対象は発注・返却の4RPCのみ(閲覧系・軽微な更新系は対象外。将来の要否は
--      都度個別に判断する)。

-- WHY: MFAは#600でオプトイン機能として実装されている(有効化ボタンを押した
--      ユーザーのみ登録)。auth.jwt()->>'aal'を無条件でaal2要求にすると、
--      MFAを一度も有効化していないユーザーは検証済みfactorが存在せず永久に
--      aal2へ到達できないため、全員が発注できなくなってしまう。
--      src/middleware.tsのnextLevel判定(検証済みfactorがある場合のみaal2昇格を
--      要求する)と同じロジックをDB側でも再現し、「MFA登録済みユーザーが
--      aal1のまま」の場合のみ拒否する。auth.mfa_factorsはauthenticatedロールに
--      直接SELECT権限が無いためSECURITY DEFINERで読む。
CREATE OR REPLACE FUNCTION has_aal2()
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_mfa_enrolled BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM auth.mfa_factors
    WHERE user_id = auth.uid() AND factor_type = 'totp' AND status = 'verified'
  ) INTO v_mfa_enrolled;

  IF NOT v_mfa_enrolled THEN
    RETURN TRUE;
  END IF;

  RETURN COALESCE(auth.jwt() ->> 'aal', '') = 'aal2';
END;
$$;

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
  IF NOT public.has_aal2() THEN
    RAISE EXCEPTION 'forbidden: aal2 required';
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
  IF NOT public.has_aal2() THEN
    RAISE EXCEPTION 'forbidden: aal2 required';
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
  IF NOT public.has_aal2() THEN
    RAISE EXCEPTION 'forbidden: aal2 required';
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
  IF NOT public.has_aal2() THEN
    RAISE EXCEPTION 'forbidden: aal2 required';
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
