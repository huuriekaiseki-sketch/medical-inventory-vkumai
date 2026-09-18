-- supabase/migrations/20260909060000_validate_consumable_order_items.sql
-- release-order: db-first
-- design: 権限=変えない（施設の writer のまま）／大きさ・量は変えない／消えるとき=変えない／
--         記録=既存の監査トリガーのまま／外部送信なし
-- lock: 関数の再定義のみ。表のロックは取らない
-- cardinality: many
--
-- WHY(2026-09-09、実測で見つけた穴): `create_consumable_order_atomic` は
--      **明細が指す消耗品を一切見ていなかった**。実 DB で測ると次の 2 つが素通りしていた:
--
--        1. **他施設の消耗品**を指した発注が作れる（施設 A の発注が施設 B の消耗品を指す）
--        2. **使用停止（retired）した消耗品**を指した発注が作れる
--
--      1 は情報漏洩ではない（RLS が読み取りを止めるので、作った本人にも中身は `null` に見える）。
--      実害は**壊れた明細が作れる**ことと、外部キーが通るかどうかで
--      **他施設の消耗品 ID の存在を当てられる**こと（存在の推測）。
--      画面には「品名が空の明細」が出るので、業務としても壊れている。
--
--      2 は E-057（消耗品の使用停止）で作った約束の穴。人が 2026-09-09 に
--      「使っていれば使用停止、使っていなければ削除」と決め、画面は使用停止のものを
--      選択肢から外している。**だが API を直接叩けば発注できた**（層の食い違い。E-055 / E-056 と同じ型）。
--      画面を開いたまま別の人が使用停止にした場合も、送信すると通ってしまう（現実に起きる競合）。
--
-- WHY(短貸返却と同じ形にする): `create_loan_return_atomic`（20260908040000）は
--      明細の紐付け先が**この施設のものか**を先に確かめてから INSERT する。
--      消耗品発注だけがその検証を持っていなかった。同じ形に揃える。
--
-- WHY(check_violation にする): 外部キー違反（23503）にすると、アプリ側の
--      「未登録の JAN」の写しと同じコードになって区別できない（C-023: 合図が同じだと層を見分けられない）。
--      業務ルール違反として 23514 を投げ、**文言で見分けて**利用者に「一覧を開き直してください」と返す。
--
-- WHY(既にある明細は触らない): 検証は**新しく作るとき**だけ。
--      使用停止にした時点で過去の発注が壊れるのは業務としておかしい（履歴は履歴のまま残す）。
--
-- WHY(元にするのは 20260908020000): この関数は 6 本の migration で再定義されており、
--      最後に定義したのは 20260908020000（作成＝確定にした版）。
--      古い版を元に書くと `has_aal2()` と `SET search_path` が消える（E-064 の実例そのもの）。
--
-- ROLLBACK:
--   20260908020000 の `create_consumable_order_atomic` の定義を CREATE OR REPLACE し直す
--   （検証ブロックと v_bad_item の宣言を外すだけ。シグネチャは変わらないので GRANT はそのまま）。

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
  v_bad_item UUID;
BEGIN
  IF NOT public.is_facility_writer(p_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;
  IF NOT public.has_aal2() THEN
    RAISE EXCEPTION 'forbidden: aal2 required';
  END IF;

  -- 明細の消耗品が「この施設のもの」かつ「使用停止でない」ことを確かめる（2026-09-09）
  SELECT (elem->>'consumable_id')::UUID INTO v_bad_item
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.consumables c
    WHERE c.id = (elem->>'consumable_id')::UUID
      AND c.facility_id = p_facility_id
      AND c.status <> 'retired'
  )
  LIMIT 1;

  IF v_bad_item IS NOT NULL THEN
    RAISE EXCEPTION 'consumable % is not orderable in this facility (retired or belongs elsewhere)', v_bad_item
      USING ERRCODE = 'check_violation';
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

-- テーブルの新設・削除ではないため refresh_schema_baseline_snapshot の呼び出しは不要。
