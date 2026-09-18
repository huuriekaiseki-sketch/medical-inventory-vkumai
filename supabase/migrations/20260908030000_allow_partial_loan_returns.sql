-- supabase/migrations/20260908030000_allow_partial_loan_returns.sql
-- release-order: db-first
--
-- design:（2026-09-08、AskUserQuestion で確認）
--   Q. 短貸を分割して返す運用はあるか        → **ある**
--   Q. 返却の明細を発注の明細に紐付けるか    → **明細ごとに紐付ける**（loan_order_item_id）
--   Q. 「未返却」バッジはいつ消すか          → **全部返るまで残し、残数を出す**
--   Q. 借りた数より多く返せるか              → **止める**（DB のトリガーで拒否）
--
-- WHY: これまで `loan_returns.loan_order_id` に部分 UNIQUE（20260828000001）が付いていて
--      **1 発注 : 1 返却**しか表せなかった。「5 本借りて 3 本だけ返す」を記録する場所が無く、
--      2 回に分けると 2 回目は「この短貸発注は既に返却登録されています」で弾かれる。
--      2026-09-08 に**分割して返す運用が実在する**ことを確認したので、表せるようにする。
--
-- WHY(JAN での突き合わせにしない): 発注明細（`loan_order_items.jan`）は**任意**なので、
--      JAN の無い明細は永久に突き合わせられない。「どの行をいくつ返したか」が確定しないと、
--      未返却の残数も過剰返却の判定も作れない。明細への外部キーで確定させる。
--
-- WHY(列は NULL 可のまま): 対象の短貸発注を選ばない返却は従来どおり作れる
--      （現場で「とりあえず返却を記録する」経路を塞がない）。紐付けが無い返却は
--      残数の計算にも過剰返却の判定にも入らない。

-- 1) 返却明細 → 発注明細の紐付け
-- cardinality: many 1 つの発注明細に対して返却明細が複数ぶら下がる（分割して返すため。これが今回の目的そのもの）
ALTER TABLE loan_return_items
  ADD COLUMN loan_order_item_id UUID REFERENCES loan_order_items(id) ON DELETE SET NULL;

-- WHY(ON DELETE SET NULL): 発注が消えても**返却の記録は残す**（返却は独立した事実）。
--      CASCADE にすると発注を消しただけで返却の記録まで消える。

-- WHY(索引): 外部キーには索引を張る（`scripts/check-foreign-key-indexes.test.sh`）。
--      残数の計算とトリガーがこの列で引くので、無いと発注明細 1 件ごとに全表走査になる。
--
-- lock: `loan_return_items` への書き込みが索引の作成中だけ止まる（CONCURRENTLY を使っていないため）。
--       手元は 42 行で体感ゼロ。**本番規模は未計測**だが、この表は 1 返却あたり数行しか増えず、
--       同じ形の索引（20260907000003 の外部キー索引群）も同じやり方で入れている。
--       行数が万単位になっている場合は CONCURRENTLY へ書き換えて別 migration に分ける
--       （CONCURRENTLY はトランザクション内で実行できないため、この migration には混ぜられない）。
CREATE INDEX loan_return_items_loan_order_item_id_idx
  ON loan_return_items (loan_order_item_id)
  WHERE loan_order_item_id IS NOT NULL;

-- 2) 1 発注 : 1 返却の制約を外す
-- WHY: これが分割返却を塞いでいた本体。P-050 の約束もこの migration で意味が変わる
--      （「2 回目を拒否する」→「借りた数を超える返却を拒否する」）。
DROP INDEX IF EXISTS loan_returns_loan_order_id_unique;

-- 3) 借りた数を超える返却を拒否する
--
-- WHY(SECURITY DEFINER にする): 判定には**その発注明細に対する返却の合計**が要る。
--      RLS の見え方に左右されると、見えない行を数え落として上限を超えて通してしまう。
--      この関数は**拒否しかしない**（何も許可しない・誰にも権限を与えない）ので、
--      DEFINER であっても認可の判断は増えない。認可は呼び出し元の RLS と RPC が行う。
--
-- WHY(FOR UPDATE で発注明細を掴む): 2 件同時に返却を作ると、どちらも「まだ余っている」と
--      読んで両方通りうる。発注明細の行を掴んでから数えることで順番を付ける（#757 の 2 と同じ形）。
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

  SELECT COALESCE(SUM(quantity), 0) INTO v_returned
  FROM public.loan_return_items
  WHERE loan_order_item_id = NEW.loan_order_item_id
    AND id IS DISTINCT FROM NEW.id;

  IF v_returned + NEW.quantity > v_ordered THEN
    RAISE EXCEPTION 'returned quantity exceeds ordered quantity (ordered %, already returned %, requested %)',
      v_ordered, v_returned, NEW.quantity
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION enforce_loan_return_not_over() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER loan_return_items_not_over
  BEFORE INSERT OR UPDATE OF quantity, loan_order_item_id ON loan_return_items
  FOR EACH ROW EXECUTE FUNCTION enforce_loan_return_not_over();

-- 4) 施設の未返却本数
--
-- WHY(SECURITY DEFINER にしない): 呼び出した利用者の権限で走らせれば RLS がそのまま効き、
--      自分の施設の行しか数えない（docs/agents/decisions.md「まず DEFINER なしを検討」）。
--      施設 ID を引数に取るが、他施設を渡しても RLS が行を返さないので 0 になる。
--
-- WHY(アプリで数えない): 全件を取って JS で数えると PostgREST の既定上限（1,000 行）で
--      静かに切り落とされ、件数が小さく出る（E-023 と同じ形）。DB 側で数える。
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
          WHERE lri.loan_order_item_id = loi.id
        ), 0)
    );
$$;

GRANT EXECUTE ON FUNCTION loan_outstanding_count(UUID) TO authenticated;

-- WHY(明細が 1 件も無い発注): EXISTS が偽になるので**未返却に数えない**。
--      物を借りていない発注に「返す物」は無い。

-- ROLLBACK:
--   DROP TRIGGER loan_return_items_not_over ON loan_return_items;
--   DROP FUNCTION enforce_loan_return_not_over();
--   DROP FUNCTION loan_outstanding_count(UUID);
--   DROP INDEX loan_return_items_loan_order_item_id_idx;
--   ALTER TABLE loan_return_items DROP COLUMN loan_order_item_id;
--   CREATE UNIQUE INDEX loan_returns_loan_order_id_unique ON loan_returns (loan_order_id)
--     WHERE loan_order_id IS NOT NULL;
--   ただし戻す前に、同じ loan_order_id を持つ返却が 2 件以上ある発注を先に片付ける必要がある
--   （分割返却を使い始めた後は UNIQUE を戻せない）。
