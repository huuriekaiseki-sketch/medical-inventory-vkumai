-- supabase/migrations/20260908060000_allow_cancelling_loan_returns.sql
-- release-order: db-first
-- design: 権限=施設の writer（返却を作れる人が直せる人。RLS は既存の facility_writer_or_admin のまま）／
--         大きさ・量は変えない／消えるとき=**行は消さない**（取り消し状態にする。証跡を残す）／
--         記録=既存の監査トリガーが status の変更を残す／外部送信なし
-- lock: 既存 CHECK の張り替えと関数の再定義のみ。ALTER TABLE ... DROP/ADD CONSTRAINT は
--       ACCESS EXCLUSIVE を取り、ADD 側は既存行を全件検証する。`loan_returns` は
--       2026-09-08 時点で **35 行**（手元の DB で実測）で一瞬で終わる。
--       本番で行数が桁違いなら NOT VALID → VALIDATE の 2 段に分ける
-- cardinality: many
--
-- WHY(E-056): 間違えて登録した返却を、**製品の中では直せなかった**。
--      API は GET と POST だけで、画面にも取り消しのボタンが無い。
--      いっぽう DB は施設の writer に DELETE を許していて、**層が食い違っていた**（実測）。
--
--      同日の判断で **作成＝確定**（E-052）にしたので、押した瞬間に確定する。
--      さらに返却は借りた数を超えられない（I-030）ので、
--      **誤った返却を 1 件入れると残数がそのぶん永久に減ったまま**になり、
--      未返却の表示が実態と合わなくなる。
--
-- WHY(削除ではなく取り消し状態): 人が「取り消し状態を作る」と判断した（2026-09-08）。
--      削除だと「間違えた記録ごと消える」ので、**誰がいつ何を取り消したか**が残らない
--      （監査ログには DELETE が残るが、業務の一覧からは消える）。
--      行を残して `cancelled` にすれば、一覧で「取り消し済み」と見え、監査にも status の
--      変更として残る。`price_histories`（値が変わったことを残す）と同じ考え方。
--
-- 変えるのは 4 か所。**残った数を数える場所は全部ここに集める**
-- （E-053 で「同じ問いの答えが 2 か所にあって食い違う」を踏んだため）:
--   1) 状態の語彙に cancelled を足す
--   2) 状態遷移のトリガーが「いつでも取り消せる／取り消しからは戻れない」を許す
--   3) 借りた数を超えない判定が、取り消した返却を数えない
--   4) 未返却の件数が、取り消した返却を数えない
--
-- ROLLBACK:
--   UPDATE loan_returns SET status = 'returned' WHERE status = 'cancelled';
--   ALTER TABLE loan_returns DROP CONSTRAINT loan_returns_status_check;
--   ALTER TABLE loan_returns ADD CONSTRAINT loan_returns_status_check
--     CHECK (status IN ('draft', 'returned'));
--   （enforce_status_forward_only / enforce_loan_return_not_over / loan_outstanding_count は
--    20260906000003 と 20260908030000 の定義に戻す）

-- =========================================================================
-- 1) 状態の語彙（I-021）
-- =========================================================================
ALTER TABLE loan_returns DROP CONSTRAINT IF EXISTS loan_returns_status_check;
ALTER TABLE loan_returns
  ADD CONSTRAINT loan_returns_status_check CHECK (status IN ('draft', 'returned', 'cancelled'));

-- =========================================================================
-- 2) 状態遷移（I-020）
--
-- WHY(4 表で共有している関数を書き換える): この関数は発注 3 種でも使われている。
--      発注側の CHECK には `cancelled` が無いので、そちらで「→ cancelled」を許しても
--      CHECK が先に弾く。**語彙を持つ表だけが取り消せる**という形になる。
--
-- WHY(取り消しからは戻れない): 取り消しは終端。戻せると「取り消した返却が復活して
--      残数がまた減る」ことになり、何が本当か分からなくなる。
-- =========================================================================
CREATE OR REPLACE FUNCTION enforce_status_forward_only()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'status cannot leave cancelled (tried % to %)', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    ELSIF NEW.status = 'cancelled' THEN
      NULL;  -- 取り消しはいつでもできる（終端へ進む）
    ELSIF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'status cannot go back from % to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- =========================================================================
-- 3) 借りた数を超えない判定（I-030）から、取り消した返却を除く
--
-- WHY: 取り消した返却が数に残っていると、**取り消しても返し直せない**。
--      「5 本借りて 5 本返した」を取り消したのに、もう 1 本も返せない状態になる。
-- =========================================================================
CREATE OR REPLACE FUNCTION enforce_loan_return_not_over()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ordered INTEGER;
  v_returned INTEGER;
BEGIN
  IF NEW.loan_order_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT quantity INTO v_ordered
  FROM public.loan_order_items
  WHERE id = NEW.loan_order_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;  -- 外部キーが先に弾く。ここへは来ない
  END IF;

  SELECT COALESCE(SUM(lri.quantity), 0) INTO v_returned
  FROM public.loan_return_items lri
  JOIN public.loan_returns lr ON lr.id = lri.loan_return_id
  WHERE lri.loan_order_item_id = NEW.loan_order_item_id
    AND lri.id IS DISTINCT FROM NEW.id
    AND lr.status <> 'cancelled';

  IF v_returned + NEW.quantity > v_ordered THEN
    RAISE EXCEPTION 'returned quantity exceeds ordered quantity (ordered %, already returned %, requested %)',
      v_ordered, v_returned, NEW.quantity
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION enforce_loan_return_not_over() FROM PUBLIC, anon, authenticated;

-- =========================================================================
-- 4) 未返却の件数（P-050 / E-053）から、取り消した返却を除く
-- =========================================================================
CREATE OR REPLACE FUNCTION loan_outstanding_count(p_facility_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COUNT(*)::INTEGER
  FROM public.loan_orders lo
  WHERE lo.facility_id = p_facility_id
    AND lo.status = 'submitted'
    AND EXISTS (
      SELECT 1
      FROM public.loan_order_items loi
      WHERE loi.loan_order_id = lo.id
        AND loi.quantity > COALESCE((
          SELECT SUM(lri.quantity)
          FROM public.loan_return_items lri
          JOIN public.loan_returns lr ON lr.id = lri.loan_return_id
          WHERE lri.loan_order_item_id = loi.id
            AND lr.status <> 'cancelled'
        ), 0)
    );
$$;

-- テーブルの新設・削除ではないため refresh_schema_baseline_snapshot の呼び出しは不要。
