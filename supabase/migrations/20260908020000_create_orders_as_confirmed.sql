-- supabase/migrations/20260908020000_create_orders_as_confirmed.sql
-- release-order: db-first
--
-- WHY: 発注・返却の状態を draft → submitted / returned へ進める経路が**アプリのどこにも無かった**
--      （E-052）。作成は列の既定値 draft のままで、UPDATE も編集画面も PUT/PATCH route も無い。
--      2026-09-08 の実測で loan_orders 13 件・loan_returns 7 件が**すべて draft**、
--      submitted / returned は 0 件だった。その結果:
--        - 「未返却」バッジは絶対に出ない（unreturned は status='submitted' が前提）
--        - 返却フォームの「対象の短貸発注」は常に空
--        - loan_returns.loan_order_id は画面からは永久に埋まらない
--        - ダッシュボードの「未返却 N 件」も常に 0
--      issue #20 のレビューが critical として塞いだ配線そのものが、その手前で到達不能だった。
--
-- 決めたこと（2026-09-08、AskUserQuestion で確認）: **作成＝確定**。
--      画面の「発注する」「返却する」を押した時点で確定とし、下書きという状態は今は作らない。
--      根拠（同日に実測）:
--        - 発注 4 route はすべて GET と POST の 2 つだけで、編集する手段が無い（draft は行き止まり）
--        - ボタンの文言（発注する／返却する）と表示（下書き）が食い違っていた
--        - 仕様書（docs/superpowers/specs/2026-06-29-order-pages-design.md）は「draft → 下書き と
--          日本語表示」としか書いておらず、**誰がいつ進めるかを誰も決めていなかった**
--
-- WHY(列の既定値は draft のまま残す): 既定値を変えると service_role・migration・将来の書き込み経路まで
--      巻き込む。RPC は発注・返却の唯一の入口なので、そこで「この経路は確定として作る」と明示する。
--      将来「下書き保存」を足したくなったら、既定 draft のまま別経路として作れる。
--      I-020（前進のみのトリガー）とも衝突しない（後戻りではなく、進んだ状態で生まれるだけ）。
--
-- WHY(4 つまとめて変える): ダッシュボードの未返却件数は submitted − returned で数えていた。
--      発注だけ submitted にすると**件数が過大になる**。返却も同時に returned にする。
--      （同じ PR でダッシュボードは紐付けベースへ変えるが、途中の状態でも壊れないよう 4 つ同時に入れる）
--
-- 変更点はどの関数も 1 行だけ: INSERT の列に status を足し、確定の値を入れる。
-- シグネチャは変えないので CREATE OR REPLACE でよい（DROP しないので GRANT も残る）。
-- 本体は 20260906000006 の定義をそのまま引き継いでいる。

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

  IF p_client_request_id IS NOT NULL THEN
    SELECT * INTO v_order FROM public.case_orders
    WHERE facility_id = p_facility_id AND client_request_id = p_client_request_id;
    v_replayed := FOUND;
  END IF;

  IF NOT v_replayed THEN
    BEGIN
      INSERT INTO public.case_orders (
        facility_id, case_datetime, procedure_name,
        patient_id, patient_initials, gender, doctor_name, client_request_id, status
      ) VALUES (
        p_facility_id, p_case_datetime, p_procedure_name,
        p_patient_id, p_patient_initials, p_gender, p_doctor_name, p_client_request_id, 'submitted'
      )
      RETURNING * INTO v_order;
    EXCEPTION WHEN unique_violation THEN
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
      INSERT INTO public.loan_orders (facility_id, procedure_name, maker, client_request_id, status)
      VALUES (p_facility_id, p_procedure_name, p_maker, p_client_request_id, 'submitted')
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
      INSERT INTO public.consumable_orders (facility_id, client_request_id, status)
      VALUES (p_facility_id, p_client_request_id, 'submitted')
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
      INSERT INTO public.loan_returns (facility_id, return_datetime, loan_order_id, client_request_id, status)
      VALUES (v_facility_id, (p_header->>'return_datetime')::TIMESTAMPTZ, v_loan_order_id, v_client_request_id, 'returned')
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

-- 既存の draft 行は触らない（2026-09-08 に確認して決めた）。
-- 手元の 発注 13 / 返却 7 はテストデータで db reset で消える。本番は未公開のため進めるべき行は無い想定。
-- もし本番に確定済みの発注が既にあった場合は、別の migration で一度だけ UPDATE する
-- （「本当に全部確定済みか」は機械では判別できないので、人が確認してから）。

-- ROLLBACK:
--   4 関数を 20260906000006_add_client_request_id_for_order_idempotency.sql の定義で
--   CREATE OR REPLACE し直す（INSERT の列から status を外すだけ。シグネチャは変わらないので
--   DROP は不要、GRANT もそのまま）。この migration より後に作られた行は submitted / returned の
--   ままで残るが、I-020（前進のみ）により draft へは戻せない。
