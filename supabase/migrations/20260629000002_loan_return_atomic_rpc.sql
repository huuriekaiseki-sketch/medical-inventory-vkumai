-- supabase/migrations/20260629000002_loan_return_atomic_rpc.sql
-- WHY: loan_returns の header + items INSERT が2ステップに分かれており、
--      items INSERT失敗時にheaderだけが孤児レコードとして残るリスクがある
--      (SPEC-tech-debt.md SET H)。既存の create_*_order_atomic と同じパターンで
--      単一トランザクションのRPCに統一し、失敗時はheaderもロールバックされるようにする。

CREATE OR REPLACE FUNCTION create_loan_return_atomic(
  p_header JSONB,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_facility_id UUID := (p_header->>'facility_id')::UUID;
  v_return loan_returns%ROWTYPE;
  v_items JSONB;
BEGIN
  IF NOT is_facility_member(v_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;

  INSERT INTO loan_returns (facility_id, return_datetime)
  VALUES (v_facility_id, (p_header->>'return_datetime')::TIMESTAMPTZ)
  RETURNING * INTO v_return;

  INSERT INTO loan_return_items (loan_return_id, jan, lot, ubd, quantity)
  SELECT
    v_return.id,
    elem->>'jan',
    elem->>'lot',
    elem->>'ubd',
    COALESCE((elem->>'quantity')::INTEGER, 1)
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM loan_return_items i
  WHERE i.loan_return_id = v_return.id;

  RETURN to_jsonb(v_return) || jsonb_build_object('items', v_items);
END;
$$;

GRANT EXECUTE ON FUNCTION create_loan_return_atomic(JSONB, JSONB) TO authenticated;
