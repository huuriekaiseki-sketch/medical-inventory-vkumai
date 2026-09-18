-- supabase/migrations/20260909080000_add_assert_facility_owns.sql
-- release-order: db-first
-- design: 権限=変えない（各 RPC の認可はそのまま）／大きさ・量は変えない／消えるとき=変えない／
--         記録=既存の監査トリガーのまま／外部送信なし
-- lock: 関数の新設と 2 本の再定義のみ。表のロックは取らない
-- cardinality: many
--
-- WHY(2026-09-09、混乱した代理人を「書き忘れられない形」にする): 同じ型の穴が 1 日で 2 件出た。
--
--   - `create_consumable_order_atomic`: 明細の消耗品を一切見ていなかった（I-035、20260909060000）
--   - `create_loan_return_atomic`: 明細は見ていたが header の発注 ID を見ていなかった（I-036、20260909070000）
--
--   原因は担当者の注意不足ではなく**構造**。`SECURITY DEFINER` の RPC は RLS を通らないので、
--   **RLS がやっていたはずの「この行はあなたのものか」を関数が自分で書き直す**必要がある。
--   確認対象は関数ごとに違い（消耗品 ID・発注 ID・発注明細 ID）、手書きで分散していた。
--   分散している限り、次に RPC を書く人も同じところで書き忘れる。
--
-- WHY(雛形ではなく共有関数にする): 「最初から確認が入っている雛形をコピーする」案もあったが、
--   **コピーは劣化する**。実際、消耗品発注の RPC は 3 か月で何度も `CREATE OR REPLACE` されたのに、
--   入力の検証だけは一度も入らなかった（E-064 と同じ形）。
--   実装が 1 か所なら、**消えたことも 1 回の変異で測れる**（RM-018）。
--
-- WHY(種別を閉じた語彙にする・動的 SQL を使わない): 表名を引数で受けて動的 SQL を組む案は、
--   識別子の注入と実行計画の両面で risk がある。確認できる参照先を**決まった語だけ**に閉じ、
--   知らない語が来たら**通さずに落とす**（fail-closed。C-021: 知らない入力を黙って通さない）。
--   語を増やすときはこの関数を 1 か所だけ直す。
--
-- WHY(SQLSTATE を種別ごとに変えない・いまの値をそのまま持ち上げる): 消耗品は 23514、
--   短貸は 23503 と、**共有関数を作る前に RPC ごとに決めた値**が既にアプリの写しと掃きの期待値に
--   なっている。ここで揃えると振る舞いが変わるので、**この migration は移し替えだけ**にする。
--   揃えるかどうかは別の判断（アプリの写しも一緒に変えることになる）。
--
-- WHY(SECURITY INVOKER でよい): 呼ぶのは `SECURITY DEFINER` の RPC で、その中では
--   定義者の権限で動くのでこの関数も定義者として実行される（RLS を通らない）。
--   万一クライアントから直接呼ばれても RLS で行が見えず「持ち主でない」と**閉じる側**に倒れる。
--   そのうえで client ロールからは REVOKE する。
--
-- ROLLBACK:
--   20260909060000 / 20260909070000 の各 RPC 定義を CREATE OR REPLACE し直し（検証を関数内へ戻す）、
--   DROP FUNCTION IF EXISTS assert_facility_owns(UUID, TEXT, UUID[], UUID);

-- =========================================================================
-- 1) 共有の検証関数
-- =========================================================================
CREATE OR REPLACE FUNCTION assert_facility_owns(
  p_facility_id UUID,
  p_kind TEXT,
  p_ids UUID[],
  p_parent_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_bad UUID;
BEGIN
  -- 施設が無い呼び出しは「何も確かめない」になってしまうので落とす（C-021）
  IF p_facility_id IS NULL THEN
    RAISE EXCEPTION 'assert_facility_owns: facility is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF p_kind = 'orderable_consumable' THEN
    -- 自施設の、使用停止でない消耗品だけを指せる（I-035）
    SELECT t.id INTO v_bad
    FROM unnest(p_ids) AS t(id)
    WHERE t.id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.consumables c
        WHERE c.id = t.id
          AND c.facility_id = p_facility_id
          AND c.status <> 'retired'
      )
    LIMIT 1;

    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'consumable % is not orderable in this facility (retired or belongs elsewhere)', v_bad
        USING ERRCODE = 'check_violation';
    END IF;

  ELSIF p_kind = 'loan_order' THEN
    -- 自施設の短貸発注だけを指せる（I-036）
    SELECT t.id INTO v_bad
    FROM unnest(p_ids) AS t(id)
    WHERE t.id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.loan_orders lo
        WHERE lo.id = t.id
          AND lo.facility_id = p_facility_id
      )
    LIMIT 1;

    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'loan order % does not belong to this facility', v_bad
        USING ERRCODE = 'foreign_key_violation';
    END IF;

  ELSIF p_kind = 'loan_order_item' THEN
    -- 自施設の発注明細だけを指せる。`p_parent_id` を渡したときは、その発注の明細に限る（I-030）
    SELECT t.id INTO v_bad
    FROM unnest(p_ids) AS t(id)
    WHERE t.id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.loan_order_items loi
        JOIN public.loan_orders lo ON lo.id = loi.loan_order_id
        WHERE loi.id = t.id
          AND lo.facility_id = p_facility_id
          AND (p_parent_id IS NULL OR lo.id = p_parent_id)
      )
    LIMIT 1;

    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'loan order item % does not belong to this facility or order', v_bad
        USING ERRCODE = 'foreign_key_violation';
    END IF;

  ELSE
    -- 知らない種別を黙って通すと、呼び出し側は「確かめたつもり」になる
    RAISE EXCEPTION 'assert_facility_owns: unknown kind %', p_kind
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION assert_facility_owns(UUID, TEXT, UUID[], UUID) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION assert_facility_owns(UUID, TEXT, UUID[], UUID) IS
  'RPC に渡された参照先が呼び出し元の施設のものかを確かめる（混乱した代理人。2026-09-09）。SECURITY DEFINER の RPC は RLS を通らないので、この確認を関数ごとに手書きしないための共有部品';

-- =========================================================================
-- 2) 消耗品発注 RPC を共有関数へ移す（20260909060000 の定義から検証だけを差し替える）
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
-- 3) 返却 RPC を共有関数へ移す（20260909070000 の定義から検証だけを差し替える）
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
