-- supabase/migrations/20260908040000_loan_return_rpc_links_order_items.sql
-- release-order: db-first
--
-- WHY: 20260908030000 で `loan_return_items.loan_order_item_id` を足したが、
--      **RPC がその値を渡していなかった**ので紐付けは永久に NULL のままだった
--      （統合テストで実測して気づいた。列を足しただけでは何も繋がらない）。
--      RPC が明細ごとの紐付けを受け取り、施設の境界を確かめてから入れる。
--
-- WHY(施設の境界をここで確かめる): `loan_order_item_id` はクライアントから来る値。
--      そのまま入れると**他施設の発注明細に紐付けて残数を動かせる**（P-017 と同じ形の穴）。
--      20260828000001 以前から `loan_order_id` については同じ検証を repository がしていたが、
--      明細 ID は新しい入口なので RPC 側で閉じる（RPC は service_role 経路からも呼ばれうる）。
--
-- WHY(選んだ発注に属することまで見る): 発注 A を選んでおいて明細は発注 B、という組み合わせを
--      許すと残数の意味が壊れる。`loan_order_id` を指定したときは、その発注の明細だけを受ける。

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
  v_client_request_id UUID := NULLIF(p_header->>'client_request_id', '')::UUID;
  v_return public.loan_returns%ROWTYPE;
  v_items JSONB;
  v_replayed BOOLEAN := FALSE;
  v_bad_item UUID;
BEGIN
  IF NOT public.is_facility_writer(v_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;
  IF NOT public.has_aal2() THEN
    RAISE EXCEPTION 'forbidden: aal2 required';
  END IF;

  -- 明細の紐付け先が、この施設（かつ指定された発注）のものであることを確かめる
  SELECT (elem->>'loan_order_item_id')::UUID INTO v_bad_item
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem
  WHERE NULLIF(elem->>'loan_order_item_id', '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.loan_order_items loi
      JOIN public.loan_orders lo ON lo.id = loi.loan_order_id
      WHERE loi.id = (elem->>'loan_order_item_id')::UUID
        AND lo.facility_id = v_facility_id
        AND (v_loan_order_id IS NULL OR lo.id = v_loan_order_id)
    )
  LIMIT 1;

  IF v_bad_item IS NOT NULL THEN
    RAISE EXCEPTION 'loan order item % does not belong to this facility or order', v_bad_item
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_client_request_id IS NOT NULL THEN
    SELECT * INTO v_return FROM public.loan_returns
    WHERE facility_id = v_facility_id AND client_request_id = v_client_request_id;
    v_replayed := FOUND;
  END IF;

  IF NOT v_replayed THEN
    BEGIN
      INSERT INTO public.loan_returns (facility_id, return_datetime, loan_order_id, client_request_id, status)
      VALUES (v_facility_id, (p_header->>'return_datetime')::TIMESTAMPTZ, v_loan_order_id, v_client_request_id, 'returned')
      RETURNING * INTO v_return;
    EXCEPTION WHEN unique_violation THEN
      -- WHY: 20260908030000 で loan_order_id の部分 UNIQUE は外したので、ここへ来るのは
      --      client_request_id の索引だけ。鍵で相手の行が見つかった場合だけ再送として扱う
      SELECT * INTO v_return FROM public.loan_returns
      WHERE facility_id = v_facility_id AND client_request_id = v_client_request_id;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      v_replayed := TRUE;
    END;
  END IF;

  IF NOT v_replayed THEN
    INSERT INTO public.loan_return_items (loan_return_id, jan, lot, ubd, quantity, loan_order_item_id)
    SELECT
      v_return.id,
      elem->>'jan',
      elem->>'lot',
      elem->>'ubd',
      COALESCE((elem->>'quantity')::INTEGER, 1),
      NULLIF(elem->>'loan_order_item_id', '')::UUID
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM public.loan_return_items i
  WHERE i.loan_return_id = v_return.id;

  RETURN to_jsonb(v_return) || jsonb_build_object('items', v_items, 'replayed', v_replayed);
END;
$$;

-- ROLLBACK:
--   create_loan_return_atomic を 20260908020000 の定義で CREATE OR REPLACE し直す
--   （明細の紐付けと境界の検証を外す。シグネチャは変わらないので GRANT はそのまま）。
--   既に入った loan_order_item_id は残るが、20260908030000 の ROLLBACK で列ごと消える。
