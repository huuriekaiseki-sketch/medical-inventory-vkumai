-- supabase/migrations/20260715000002_add_unit_price_snapshot_to_order_rpcs.sql
-- issue #23 Part2 Set A-2: 発注作成RPC内で単価スナップショットを保存する。
-- WHY: 既存migrationは追記・修正禁止のため、CREATE OR REPLACE FUNCTIONで既存RPCを更新する。
--      単価解決に失敗しても発注作成自体は失敗させない（best-effort、未解決事項1・2・3・
--      受け入れ条件「データ精度」に対応）。

-- WHY(重複実装指摘対応): create_case_order_atomicとcreate_loan_order_atomicは
--      jan→products→distributor_products→hospital_pricesという全く同一の単価解決クエリを
--      使用していた（レビュー指摘: important「重複実装」）。共通のSQL関数
--      resolve_jan_unit_price(p_jan, p_facility_id)に集約し、両RPCから呼び出す形にする。
--      consumable_order側はconsumable_id→consumables(jan)というjan解決の前段が異なるため、
--      consumables.janを求めたうえで同じresolve_jan_unit_priceを呼び出す。
CREATE OR REPLACE FUNCTION resolve_jan_unit_price(
  p_jan TEXT,
  p_facility_id UUID
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT MIN(hp.purchase_price)
  FROM products p
  JOIN distributor_products dp ON dp.product_id = p.id
  JOIN hospital_prices hp
    ON hp.distributor_product_id = dp.id
   AND hp.facility_id = p_facility_id
  WHERE p.jan = p_jan
$$;

-- WHY(コードレビュー指摘対応・important): 本関数にGRANT EXECUTEが無いまま暗黙のPUBLIC権限に
-- 依存していた。is_facility_member()に対して20260711000001_grant_execute_is_facility_member.sql
-- が明示的GRANTを追加した既存実績と同じ理由で、明示的に付与する（将来PUBLICへの自動権限付与が
-- revokeされた場合でも、create_*_order_atomicからの呼び出しがbest-effort原則を保てるように）。
GRANT EXECUTE ON FUNCTION resolve_jan_unit_price(TEXT, UUID) TO authenticated;

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
SET search_path = public
AS $$
DECLARE
  v_order case_orders%ROWTYPE;
  v_items JSONB;
BEGIN
  IF NOT is_facility_member(p_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;

  INSERT INTO case_orders (
    facility_id, case_datetime, procedure_name,
    patient_id, patient_initials, gender, doctor_name
  ) VALUES (
    p_facility_id, p_case_datetime, p_procedure_name,
    p_patient_id, p_patient_initials, p_gender, p_doctor_name
  )
  RETURNING * INTO v_order;

  -- 単価解決はresolve_jan_unit_price()に委譲する（未解決事項3: MIN(purchase_price)採用）。
  -- 該当行なしの場合はNULLのまま挿入する（best-effort、例外を投げない）。
  INSERT INTO case_order_items (case_order_id, jan, lot, ubd, quantity, unit_price)
  SELECT
    v_order.id,
    elem->>'jan',
    elem->>'lot',
    elem->>'ubd',
    COALESCE((elem->>'quantity')::INTEGER, 1),
    resolve_jan_unit_price(elem->>'jan', p_facility_id)
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM case_order_items i
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
SET search_path = public
AS $$
DECLARE
  v_order loan_orders%ROWTYPE;
  v_items JSONB;
BEGIN
  IF NOT is_facility_member(p_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;

  INSERT INTO loan_orders (facility_id, procedure_name, maker)
  VALUES (p_facility_id, p_procedure_name, p_maker)
  RETURNING * INTO v_order;

  -- case_order_itemsと同型の単価解決パス（jan起点）。resolve_jan_unit_price()に委譲する。
  INSERT INTO loan_order_items (loan_order_id, jan, name, quantity, unit_price)
  SELECT
    v_order.id,
    elem->>'jan',
    elem->>'name',
    COALESCE((elem->>'quantity')::INTEGER, 1),
    resolve_jan_unit_price(elem->>'jan', p_facility_id)
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM loan_order_items i
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
SET search_path = public
AS $$
DECLARE
  v_order consumable_orders%ROWTYPE;
  v_items JSONB;
BEGIN
  IF NOT is_facility_member(p_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;

  INSERT INTO consumable_orders (facility_id)
  VALUES (p_facility_id)
  RETURNING * INTO v_order;

  -- 単価解決: consumable_id → consumables(jan) を経てから resolve_jan_unit_price() に委譲する。
  -- consumables.janがNULL、または該当行なしの場合はNULLのまま挿入する（best-effort）。
  INSERT INTO consumable_order_items (consumable_order_id, consumable_id, quantity, unit_price)
  SELECT
    v_order.id,
    (elem->>'consumable_id')::UUID,
    COALESCE((elem->>'quantity')::INTEGER, 1),
    (
      SELECT resolve_jan_unit_price(c.jan, p_facility_id)
      FROM consumables c
      WHERE c.id = (elem->>'consumable_id')::UUID
    )
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM consumable_order_items i
  WHERE i.consumable_order_id = v_order.id;

  RETURN to_jsonb(v_order) || jsonb_build_object('items', v_items);
END;
$$;
