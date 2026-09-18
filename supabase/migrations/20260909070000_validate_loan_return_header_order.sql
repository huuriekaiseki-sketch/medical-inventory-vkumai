-- supabase/migrations/20260909070000_validate_loan_return_header_order.sql
-- release-order: db-first
-- design: 権限=変えない（施設の writer のまま）／大きさ・量は変えない／消えるとき=変えない／
--         記録=既存の監査トリガーのまま／外部送信なし
-- lock: 関数の再定義のみ。表のロックは取らない
-- cardinality: many
--
-- WHY(2026-09-09、実測で見つけた穴): `create_loan_return_atomic` は
--      **明細の紐付け先は確かめていたのに、header の `loan_order_id` は確かめていなかった**。
--      明細を 1 つも紐付けなければ検証の WHERE 句に 1 行も入らないので、
--      **他施設の発注 ID をそのまま入れられる**。実測:
--
--        header に施設 B の発注 ID / 明細の紐付けなし → 通る
--        できた行: facility_id=施設A, loan_order_id=施設Bの発注
--
-- WHY(アプリに検証があるのに塞ぐ): `src/lib/loan-returns/repository.ts` は
--      「facilityId に属する loan_order か」を INSERT 前に確かめており、
--      20260908040000 のコメントは **「テナント境界検証は完了済みのため、RPC 側では再検証しない」**
--      と書いていた。**その前提が崩れている。**
--      この RPC は `authenticated` に GRANT されていて、**利用者は Next.js を経由せず
--      PostgREST から直接呼べる**（このリポジトリの `decisions/db-rls.md` に書いてあるとおり、
--      実効的な境界は DB）。アプリ層だけに置いた検査は、画面の出し分けと同じで防御ではない（T-014 の型）。
--
-- WHY(明細の検証と同じ形・同じ SQLSTATE にする): すぐ下にある `loan_order_item_id` の検証と
--      対になる判定なので、書き方も返すコードも揃える（23503）。
--      利用者向けの文言はアプリ側が既に持っている（`LOAN_ORDER_NOT_FOUND_ERROR`）。
--      画面の選択肢には自施設の発注しか出ないので、ここへ来るのは**直接叩いたとき**だけ。
--
-- WHY(元にするのは 20260908040000): この関数は 5 本の migration で再定義されており、
--      最後の版が 20260908040000。古い版を元にすると aal2 と明細の検証が消える（E-064）。
--
-- ROLLBACK:
--   20260908040000 の定義を CREATE OR REPLACE し直す（header の検証ブロックを外すだけ）。

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

  -- header で選んだ発注が、この施設のものであることを確かめる（2026-09-09）
  -- 明細を 1 つも紐付けない返却では、下の明細の検証が 1 行も見ないため、ここが唯一の関門になる
  IF v_loan_order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.loan_orders lo
    WHERE lo.id = v_loan_order_id
      AND lo.facility_id = v_facility_id
  ) THEN
    RAISE EXCEPTION 'loan order % does not belong to this facility', v_loan_order_id
      USING ERRCODE = 'foreign_key_violation';
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

-- テーブルの新設・削除ではないため refresh_schema_baseline_snapshot の呼び出しは不要。
