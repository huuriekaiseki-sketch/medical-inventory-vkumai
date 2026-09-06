-- supabase/migrations/20260906000006_add_client_request_id_for_order_idempotency.sql
-- WHY: issue #757 の 2（同時更新の残り: 発注の冪等性、P-053）。
--      発注・返却の作成 RPC は呼ばれるたびに新しい行を作る。画面は送信ボタンを disabled に
--      するだけなので、応答が返る前の通信断・タブの二重化・リロード後の再送では同じ発注が
--      2 件できる（在庫の発注数と金額が倍になる）。UI の disabled は利便性であって防御ではない。
--      画面がフォームを開いたときに 1 回だけ UUID（client_request_id）を作って送り、
--      DB が「同じ施設 × 同じ client_request_id は 1 行」を UNIQUE で守る。RPC は同じ
--      client_request_id で再送されたら新しい行を作らず、既に作った行をそのまま返す
--      （再送した側も成功として扱えるので、利用者はリトライしてよい）。
--      2 件が同時に走った場合は UNIQUE 違反を拾って相手の行を返す（成功 1 / 再生 1、行は 1 件）。
--      client_request_id を渡さない呼び出しは従来どおり毎回新しい行を作る（後方互換。
--      API 経由の画面は必ず渡す）。
--      検査対象は発注 3 種と返却の 4 RPC。返却は loan_order_id の部分 UNIQUE（P-050）が
--      「同じ短貸発注への 2 回目」を既に止めているが、対象を選ばない返却には効かないので同じ鍵を足す。

ALTER TABLE case_orders ADD COLUMN client_request_id UUID;
ALTER TABLE loan_orders ADD COLUMN client_request_id UUID;
ALTER TABLE consumable_orders ADD COLUMN client_request_id UUID;
ALTER TABLE loan_returns ADD COLUMN client_request_id UUID;

-- WHY: 鍵は施設ごとに一意にする。画面が生成する UUID の衝突は現実的に無いが、
--      鍵の意味は「この施設のこの送信」であり、他施設の鍵と比較する理由が無い。
--      施設を先頭にすることで、RPC の再送検索（facility_id, client_request_id）がこの索引を使う。
CREATE UNIQUE INDEX case_orders_client_request_id_unique
  ON case_orders (facility_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX loan_orders_client_request_id_unique
  ON loan_orders (facility_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX consumable_orders_client_request_id_unique
  ON consumable_orders (facility_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX loan_returns_client_request_id_unique
  ON loan_returns (facility_id, client_request_id) WHERE client_request_id IS NOT NULL;

-- WHY: 引数を足すと別の関数（オーバーロード）になり、PostgREST が呼び分けに迷うので
--      旧シグネチャを DROP してから作り直す。DROP で GRANT も消えるので末尾で付け直す。
--      返却 RPC は p_header JSONB の中に client_request_id を入れるのでシグネチャは変わらない。
DROP FUNCTION create_case_order_atomic(UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB);
DROP FUNCTION create_loan_order_atomic(UUID, TEXT, TEXT, JSONB);
DROP FUNCTION create_consumable_order_atomic(UUID, JSONB);

CREATE OR REPLACE FUNCTION create_case_order_atomic(
  p_facility_id UUID,
  p_case_datetime TIMESTAMPTZ,
  p_procedure_name TEXT,
  p_patient_id TEXT,
  p_patient_initials TEXT,
  p_gender TEXT,
  p_doctor_name TEXT,
  p_items JSONB,
  p_client_request_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.case_orders%ROWTYPE;
  v_items JSONB;
  v_replayed BOOLEAN := FALSE;
BEGIN
  IF NOT public.is_facility_writer(p_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;
  IF NOT public.has_aal2() THEN
    RAISE EXCEPTION 'forbidden: aal2 required';
  END IF;

  -- 再送: 同じ施設 × 同じ鍵の行が既にあればそれを返す（認可チェックの後なので他施設の探りには使えない）
  IF p_client_request_id IS NOT NULL THEN
    SELECT * INTO v_order FROM public.case_orders
    WHERE facility_id = p_facility_id AND client_request_id = p_client_request_id;
    v_replayed := FOUND;
  END IF;

  IF NOT v_replayed THEN
    BEGIN
      INSERT INTO public.case_orders (
        facility_id, case_datetime, procedure_name,
        patient_id, patient_initials, gender, doctor_name, client_request_id
      ) VALUES (
        p_facility_id, p_case_datetime, p_procedure_name,
        p_patient_id, p_patient_initials, p_gender, p_doctor_name, p_client_request_id
      )
      RETURNING * INTO v_order;
    EXCEPTION WHEN unique_violation THEN
      -- 同時送信: 相手が先にコミットしていた。相手の行を返す
      SELECT * INTO v_order FROM public.case_orders
      WHERE facility_id = p_facility_id AND client_request_id = p_client_request_id;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      v_replayed := TRUE;
    END;
  END IF;

  IF NOT v_replayed THEN
    INSERT INTO public.case_order_items (case_order_id, jan, lot, ubd, quantity, unit_price)
    SELECT
      v_order.id,
      elem->>'jan',
      elem->>'lot',
      elem->>'ubd',
      COALESCE((elem->>'quantity')::INTEGER, 1),
      public.resolve_jan_unit_price(elem->>'jan', p_facility_id)
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM public.case_order_items i
  WHERE i.case_order_id = v_order.id;

  RETURN to_jsonb(v_order) || jsonb_build_object('items', v_items, 'replayed', v_replayed);
END;
$$;

CREATE OR REPLACE FUNCTION create_loan_order_atomic(
  p_facility_id UUID,
  p_procedure_name TEXT,
  p_maker TEXT,
  p_items JSONB,
  p_client_request_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.loan_orders%ROWTYPE;
  v_items JSONB;
  v_replayed BOOLEAN := FALSE;
BEGIN
  IF NOT public.is_facility_writer(p_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;
  IF NOT public.has_aal2() THEN
    RAISE EXCEPTION 'forbidden: aal2 required';
  END IF;

  IF p_client_request_id IS NOT NULL THEN
    SELECT * INTO v_order FROM public.loan_orders
    WHERE facility_id = p_facility_id AND client_request_id = p_client_request_id;
    v_replayed := FOUND;
  END IF;

  IF NOT v_replayed THEN
    BEGIN
      INSERT INTO public.loan_orders (facility_id, procedure_name, maker, client_request_id)
      VALUES (p_facility_id, p_procedure_name, p_maker, p_client_request_id)
      RETURNING * INTO v_order;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_order FROM public.loan_orders
      WHERE facility_id = p_facility_id AND client_request_id = p_client_request_id;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      v_replayed := TRUE;
    END;
  END IF;

  IF NOT v_replayed THEN
    INSERT INTO public.loan_order_items (loan_order_id, jan, name, quantity, unit_price)
    SELECT
      v_order.id,
      elem->>'jan',
      elem->>'name',
      COALESCE((elem->>'quantity')::INTEGER, 1),
      public.resolve_jan_unit_price(elem->>'jan', p_facility_id)
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM public.loan_order_items i
  WHERE i.loan_order_id = v_order.id;

  RETURN to_jsonb(v_order) || jsonb_build_object('items', v_items, 'replayed', v_replayed);
END;
$$;

CREATE OR REPLACE FUNCTION create_consumable_order_atomic(
  p_facility_id UUID,
  p_items JSONB,
  p_client_request_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.consumable_orders%ROWTYPE;
  v_items JSONB;
  v_replayed BOOLEAN := FALSE;
BEGIN
  IF NOT public.is_facility_writer(p_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;
  IF NOT public.has_aal2() THEN
    RAISE EXCEPTION 'forbidden: aal2 required';
  END IF;

  IF p_client_request_id IS NOT NULL THEN
    SELECT * INTO v_order FROM public.consumable_orders
    WHERE facility_id = p_facility_id AND client_request_id = p_client_request_id;
    v_replayed := FOUND;
  END IF;

  IF NOT v_replayed THEN
    BEGIN
      INSERT INTO public.consumable_orders (facility_id, client_request_id)
      VALUES (p_facility_id, p_client_request_id)
      RETURNING * INTO v_order;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_order FROM public.consumable_orders
      WHERE facility_id = p_facility_id AND client_request_id = p_client_request_id;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      v_replayed := TRUE;
    END;
  END IF;

  IF NOT v_replayed THEN
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
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM public.consumable_order_items i
  WHERE i.consumable_order_id = v_order.id;

  RETURN to_jsonb(v_order) || jsonb_build_object('items', v_items, 'replayed', v_replayed);
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
  v_client_request_id UUID := NULLIF(p_header->>'client_request_id', '')::UUID;
  v_return public.loan_returns%ROWTYPE;
  v_items JSONB;
  v_replayed BOOLEAN := FALSE;
BEGIN
  IF NOT public.is_facility_writer(v_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;
  IF NOT public.has_aal2() THEN
    RAISE EXCEPTION 'forbidden: aal2 required';
  END IF;

  IF v_client_request_id IS NOT NULL THEN
    SELECT * INTO v_return FROM public.loan_returns
    WHERE facility_id = v_facility_id AND client_request_id = v_client_request_id;
    v_replayed := FOUND;
  END IF;

  IF NOT v_replayed THEN
    BEGIN
      INSERT INTO public.loan_returns (facility_id, return_datetime, loan_order_id, client_request_id)
      VALUES (v_facility_id, (p_header->>'return_datetime')::TIMESTAMPTZ, v_loan_order_id, v_client_request_id)
      RETURNING * INTO v_return;
    EXCEPTION WHEN unique_violation THEN
      -- WHY: unique_violation は client_request_id の索引だけでなく loan_order_id の部分 UNIQUE
      --      （P-050、同じ短貸発注への 2 回目の返却）でも起きる。鍵で相手の行が見つかった場合だけ
      --      再送として扱い、見つからなければ元の 23505 をそのまま上げる（アプリが
      --      「既に返却登録されています」に写像する）
      SELECT * INTO v_return FROM public.loan_returns
      WHERE facility_id = v_facility_id AND client_request_id = v_client_request_id;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      v_replayed := TRUE;
    END;
  END IF;

  IF NOT v_replayed THEN
    INSERT INTO public.loan_return_items (loan_return_id, jan, lot, ubd, quantity)
    SELECT
      v_return.id,
      elem->>'jan',
      elem->>'lot',
      elem->>'ubd',
      COALESCE((elem->>'quantity')::INTEGER, 1)
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM public.loan_return_items i
  WHERE i.loan_return_id = v_return.id;

  RETURN to_jsonb(v_return) || jsonb_build_object('items', v_items, 'replayed', v_replayed);
END;
$$;

-- DROP で消えた権限を付け直す（20260626002000 / 20260627010001 と同じ authenticated のみ。
-- anon は is_facility_writer が auth.uid() NULL で必ず false になるので、従来どおり REVOKE はしない）
GRANT EXECUTE ON FUNCTION create_case_order_atomic(UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION create_loan_order_atomic(UUID, TEXT, TEXT, JSONB, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION create_consumable_order_atomic(UUID, JSONB, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION create_loan_return_atomic(JSONB, JSONB) TO authenticated;

-- ROLLBACK:
--   4 関数を 20260806000001_require_aal2_for_order_rpcs.sql の定義で作り直し（新シグネチャ 3 本は DROP）、
--   GRANT を付け直す → 4 つの部分 UNIQUE インデックスを DROP → 4 表の client_request_id 列を DROP
