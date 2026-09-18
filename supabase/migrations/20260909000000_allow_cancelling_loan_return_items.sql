-- supabase/migrations/20260909000000_allow_cancelling_loan_return_items.sql
-- release-order: db-first
-- design: 権限=施設の writer（返却を作れる人が直せる人。RLS は既存の親経由の EXISTS のまま）／
--         大きさ・量は変えない（列を 1 つ足すだけ）／消えるとき=**行は消さない**（取り消し状態にする）／
--         記録=既存の監査トリガーが status の変更を残す（20260907008000 で明細も施設つきで記録される）／
--         外部送信なし
-- lock: 列の追加は既定値つき NOT NULL だが、PostgreSQL 11 以降は**書き換えを伴わない**
--       （既定値はカタログに入るだけ）。ACCESS EXCLUSIVE は取るが一瞬で終わる。
--       CHECK は列と同時に付けるので既存行の全件検証は起きない。
--       実測: `loan_return_items` は 2026-09-09 時点で **0 行**（手元の DB を作り直した直後のため）。
--       **この数字は根拠として弱い**ので、行数に依らない理由も書く: 既定値が定数の列追加は
--       カタログだけを書き換えるため、行数が何桁でも所要時間は変わらない。
--       本番で行数が桁違いでもこのままでよい
-- cardinality: many
--
-- WHY(E-056 の残り): 返却は**回ごと**には取り消せるようにした（20260908060000）。
--      だが 1 回の返却で複数の品目を返したとき、**そのうち 1 品目だけが間違い**でも
--      回ごと取り消して全品目を入れ直すしかなかった。
--      物理的には「A を 2 本返したのは正しく、B を 1 本返したのが間違い」が普通に起きる。
--      人の判断（2026-09-09）で**品目ごとに取り消せる**ようにする。
--
-- WHY(数量の書き換えではなく取り消し): 「返した数を後から直す」案もあったが、
--      **元は何本だったかが一覧から追えなくなる**（監査ログを開かないと分からない）。
--      行を残して `cancelled` にすれば、一覧で「取り消し済み」と見え、
--      親の返却の取り消し（20260908060000）と同じ考え方で揃う。
--
-- 変えるのは 3 か所。**残った数を数える場所は全部ここに集める**
-- （E-053 で「同じ問いの答えが 2 か所にあって食い違う」を踏んだため。
--  アプリ側の 2 か所は同じコミットで直す）:
--   1) 明細に状態の語彙を足す（active / cancelled）
--   2) 借りた数を超えない判定が、取り消した**明細**を数えない
--   3) 未返却の件数が、取り消した**明細**を数えない
--
-- ROLLBACK:
--   ALTER TABLE loan_return_items DROP COLUMN status;
--   （enforce_loan_return_not_over / loan_outstanding_count は 20260908060000 の定義に戻す）

-- =========================================================================
-- 1) 明細の状態の語彙（I-021 と同じ考え方）
--
-- WHY(既定を active にする): 既存の行はすべて「生きている返却の明細」なので、
--      既定値で意味が変わらない。NULL 可にすると「NULL は取り消しか否か」を
--      数える場所ごとに解釈することになり、E-053 と同じ食い違いを生む。
-- =========================================================================
ALTER TABLE loan_return_items
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'cancelled'));

COMMENT ON COLUMN loan_return_items.status IS
  '明細ごとの取り消し（E-056 の残り、2026-09-09）。cancelled は残数・未返却の計算から除かれる';

-- WHY(取り消しからは戻れない): 親の返却と同じ規則を明細にも掛ける。
--      戻せると「取り消した明細が復活して残数がまた減る」ことになり、何が本当か分からなくなる。
--      `enforce_status_forward_only` は OLD/NEW の status だけを見る汎用のトリガー関数なので、
--      そのまま付けられる（`active` からは cancelled へしか動かせない）。
DROP TRIGGER IF EXISTS loan_return_items_status_forward_only ON loan_return_items;
CREATE TRIGGER loan_return_items_status_forward_only
  BEFORE UPDATE ON loan_return_items
  FOR EACH ROW EXECUTE FUNCTION enforce_status_forward_only();

-- =========================================================================
-- 2) 借りた数を超えない判定（I-030）から、取り消した**明細**を除く
--
-- WHY: 取り消した明細が数に残っていると、**取り消しても返し直せない**。
--      「2 本返した」うち 1 本を取り消したのに、その 1 本を返せない状態になる。
--
-- WHY(20260908060000 の本文を元にする): この関数は 20260906000003 → 20260908030000 →
--      20260908060000 と 3 回書き直されている。**最後に定義した版**（20260908060000）に
--      `lri.status` の条件を足しただけで、親の cancelled 判定は残してある
--      （古い版を元にすると後から足した守りが消える。E-064）。
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

  -- 取り消した明細は数に足さないので、そもそも上限の判定をしない
  IF NEW.status = 'cancelled' THEN
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
    AND lri.status <> 'cancelled'
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
-- 3) 未返却の件数（P-050 / E-053）から、取り消した**明細**を除く
--
-- WHY(20260908060000 の本文を元にする): 上と同じ理由。親の cancelled 判定を残したまま
--      明細の条件を足す。
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
            AND lri.status <> 'cancelled'
            AND lr.status <> 'cancelled'
        ), 0)
    );
$$;

-- テーブルの新設・削除ではないため refresh_schema_baseline_snapshot の呼び出しは不要。
