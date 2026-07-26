-- supabase/migrations/20260726120000_add_loan_order_id_to_loan_return_atomic_rpc.sql
-- WHY: create_loan_return_atomic(issue #20 Set A以前に追加)はheader+itemsのみをINSERTし、
--      loan_order_id(未返却判定用のFK)を扱えなかった。そのためproduction caller
--      (src/lib/loan-returns/repository.ts)はRPCを使わずheader/items別々の2回INSERTのままで、
--      orphan header混入リスクが残っていた(architecture review 2026-07-26 issue #2)。
--      テナント境界チェック(loan_order_idが呼び出し施設に属するか)はJS側で既に検証済み
--      (issue #20 レビュー指摘: critical)であり、このRPCでは再検証せずそのままinsertする。

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
  v_loan_order_id UUID := NULLIF(p_header->>'loan_order_id', '')::UUID;
  v_return loan_returns%ROWTYPE;
  v_items JSONB;
BEGIN
  IF NOT is_facility_member(v_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;

  INSERT INTO loan_returns (facility_id, return_datetime, loan_order_id)
  VALUES (v_facility_id, (p_header->>'return_datetime')::TIMESTAMPTZ, v_loan_order_id)
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
