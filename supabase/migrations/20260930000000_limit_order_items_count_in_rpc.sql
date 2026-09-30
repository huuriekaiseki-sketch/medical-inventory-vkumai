-- supabase/migrations/20260930000000_limit_order_items_count_in_rpc.sql
-- release-order: db-first
-- design: 権限=変えない（各 RPC の認可はそのまま）／大きさ・量=1 件の発注・返却の明細は 100 件まで
--         （aidd.config.json の limits.orderItemsMax。人が 2026-09-20 に決めた値）／消えるとき=変えない／
--         記録=既存の監査トリガーのまま／外部送信なし
-- lock: 関数の新設と 4 本の再定義のみ。表のロックは取らない
-- cardinality: many
--
-- WHY(issue #825、2026-09-30): issue #813（PR #822）で、発注 4 種の明細の件数に 100 件の上限を入れた。
--   ただし効くのは **API の入口（zod）だけ**で、RPC を PostgREST 経由で直接呼ぶ経路には上限が無かった。
--   文字数の上限（20260907000004 の CHECK）は「入口と DB の 2 枚」で守っているのに、件数は 1 枚だった。
--   利用者が通れる書き込みの経路は RPC だけ（明細の表への直接 INSERT は 20260909040000 で
--   authenticated から取り上げ済み）なので、RPC で数えれば利用者の経路は全部塞がる。
--
-- WHY(共有関数にする): `assert_facility_owns`（20260909080000）と同じ理由。4 本の RPC に同じ確認を
--   手書きで置くと、次に RPC を書く人が書き忘れる。実装が 1 か所なら、消えたことも 1 回の変異で測れる
--   （RM-021）。RPC 側は「呼ぶ 1 行」だけを足す。
--
-- WHY(数字を関数の中に 1 つだけ書く): DB の関数は aidd.config.json を読めない。文字数の上限の CHECK と
--   同じで、数字は migration に 1 か所だけ置き、設定との一致は
--   scripts/check-order-items-limit-consistency.test.sh が機械で突き合わせる。**ここ以外に 100 を書かない。**
--
-- WHY(表の制約やトリガーにしない): 明細の表にトリガーを付ければ service_role の経路まで塞げるが、
--   1 行足すたびに親の明細を数え直すので明細が多い発注ほど遅くなり、既存の行が上限を超えていないかを
--   本番で先に数える必要もある。service_role は鍵を持つ運用者の経路で利用者は通れない。
--   人が 2026-09-30 に「RPC で数える」を選んだ（仕様書 docs/superpowers/specs/2026-09-30-order-items-limit-in-rpc-design.md）。
--
-- WHY(認可の判定の直後・再送の判定より前で数える): 上限超えの要求が `client_request_id` の再送として
--   通る余地を消す。数えるのは NULL・空でない配列だけ（0 件・NULL は既存の動きのまま通す）。
--
-- WHY(SQLSTATE は 23514): 文字数の上限（CHECK）と同じ種類にする。API の入口が先に止めるので、
--   このエラーに当たるのは RPC を直接呼んだ場合だけ。アプリの写しは変えない。
--
-- 4 本の本体は、決まり（.claude/rules/db-schema.md「最後に定義した版を元にする」）に従い、
--   症例発注・短貸発注は 20260908020000、消耗品発注・短貸返却は 20260909080000 の定義をそのまま引き継ぎ、
--   `PERFORM public.assert_items_within_limit(p_items);` の 1 行だけを足した。
--
-- ROLLBACK:
--   20260908020000（create_case_order_atomic / create_loan_order_atomic）と
--   20260909080000（create_consumable_order_atomic / create_loan_return_atomic）の各定義を CREATE OR REPLACE し直し、
--   DROP FUNCTION IF EXISTS assert_items_within_limit(JSONB);

-- =========================================================================
-- 1) 共有の件数の確認
-- =========================================================================
CREATE OR REPLACE FUNCTION assert_items_within_limit(
  p_items JSONB
)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  -- aidd.config.json の limits.orderItemsMax と同じ値（scripts/check-order-items-limit-consistency.test.sh が突き合わせる）
  v_max CONSTANT INTEGER := 100;
  v_count INTEGER;
BEGIN
  -- NULL は「明細なし」。既存の RPC は COALESCE(p_items, '[]') で扱っているので、ここでも通す
  IF p_items IS NULL THEN
    RETURN;
  END IF;

  -- 配列でないものは jsonb_array_length が落とす（既存の RPC の jsonb_array_elements と同じ振る舞い。黙って通さない）
  v_count := jsonb_array_length(p_items);

  IF v_count > v_max THEN
    RAISE EXCEPTION 'too many items: % (limit %)', v_count, v_max
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION assert_items_within_limit(JSONB) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION assert_items_within_limit(JSONB) IS
  '1 件の発注・返却の明細の件数が上限（aidd.config.json の limits.orderItemsMax）以内かを確かめる（issue #825、2026-09-30）。RPC を直接呼ぶ経路にも API の入口と同じ上限を掛けるための共有部品';

-- =========================================================================
-- 2) 症例発注（20260908020000 の定義 + 件数の確認 1 行）
-- =========================================================================
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

  -- 明細の件数は上限まで（I-038）
  PERFORM public.assert_items_within_limit(p_items);

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

-- =========================================================================
-- 3) 短貸発注（20260908020000 の定義 + 件数の確認 1 行）
-- =========================================================================
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

  -- 明細の件数は上限まで（I-038）
  PERFORM public.assert_items_within_limit(p_items);

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

-- =========================================================================
-- 4) 消耗品発注（20260909080000 の定義 + 件数の確認 1 行）
-- =========================================================================
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

  -- 明細の件数は上限まで（I-038）
  PERFORM public.assert_items_within_limit(p_items);

  -- 明細が指す消耗品は、自施設の・使用停止でないものだけ（I-035）
  PERFORM public.assert_facility_owns(
    p_facility_id,
    'orderable_consumable',
    ARRAY(
      SELECT (elem->>'consumable_id')::UUID
      FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem
    )
  );

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

-- =========================================================================
-- 5) 短貸返却（20260909080000 の定義 + 件数の確認 1 行）
-- =========================================================================
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

  -- 明細の件数は上限まで（I-038）
  PERFORM public.assert_items_within_limit(p_items);

  -- header で選んだ発注は自施設のものだけ（I-036。NULL は「選んでいない」なので素通り）
  PERFORM public.assert_facility_owns(v_facility_id, 'loan_order', ARRAY[v_loan_order_id]);

  -- 明細の紐付け先も自施設の、かつ選んだ発注のものだけ（I-030 の前提）
  PERFORM public.assert_facility_owns(
    v_facility_id,
    'loan_order_item',
    ARRAY(
      SELECT NULLIF(elem->>'loan_order_item_id', '')::UUID
      FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem
    ),
    v_loan_order_id
  );

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
