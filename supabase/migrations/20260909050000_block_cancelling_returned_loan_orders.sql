-- supabase/migrations/20260909050000_block_cancelling_returned_loan_orders.sql
-- release-order: db-first
-- design: 権限=変えない（施設の writer のまま）／大きさ・量は変えない（列も表も足さない）／
--         消えるとき=変えない／記録=既存の監査トリガーのまま／外部送信なし
-- lock: トリガー関数の新設と、`loan_orders` へのトリガー追加のみ。
--       CREATE TRIGGER は対象表に SHARE ROW EXCLUSIVE を取るが既存行は検証しないので、
--       行数に依らず一瞬で終わる（`loan_orders` は手元の DB で 4 行）。
-- cardinality: many
--
-- WHY(2026-09-09、人が決めた業務規則): 昨日入れた発注の取り消し（E-056、20260908070000）は
--      **返却との噛み合わせを決めていなかった**。実測すると次が素通りしていた:
--
--        - 2 本借りて 2 本返した発注を、そのまま取り消せる
--          （返却の行は `returned` のまま残り、取り消された発注を指し続ける）
--
--      人の判断（2026-09-09）は「**取り消せない**」。物が動いた事実がある以上、
--      発注を「無かったこと」にはできない。直したいときは
--      **先に返却を取り消してから発注を取り消す**（返却の取り消しは 20260908060000 で作ってある）。
--
-- WHY(逆向き（取り消し済みの発注へあとから返却を作る）は塞がない): 同じ判断の場で
--      「作れてよい」と決まった。取り消したあとに物が返ってきたときの記録先が要るため。
--      **この規則は状態の遷移だけを見る**（取り消す瞬間に生きた返却が無いこと）であって、
--      「取り消し済みの発注には返却が無い」という不変条件ではない。
--
-- WHY(「生きた返却」の数え方を残数と揃える): 残数（`loan_outstanding_count`）と
--      過剰返却の判定（`enforce_loan_return_not_over`）は**明細の紐付け**で数えている。
--      ここだけ header の `loan_order_id` で数えると、紐付けだけがある返却
--      （header は NULL でも明細はこの発注を指す。`create_loan_return_atomic` が許す形）を
--      見落として、**残数を減らした返却があるのに取り消せてしまう**。
--      そこで header と明細の**どちらか**で紐づく、取り消されていない返却を数える。
--
-- WHY(SECURITY DEFINER): 判定は `loan_returns` / `loan_return_items` を読む。
--      呼び出し側の権限のまま読むと、RLS で見えない行があったとき**黙って 0 件**になり
--      素通りする（fail-open）。`enforce_loan_return_not_over` と同じ理由で定義者権限にし、
--      クライアントから直接呼べないよう REVOKE する。
--
-- WHY(汎用の enforce_status_forward_only は触らない): あれは 4 表が共有していて、
--      最後に定義したのは 20260909010000（`retired` を足した版）。
--      ここで書き直すと**その版を元にしないと強化が消える**（E-064）。
--      短貸だけの規則なので、`loan_orders` 専用のトリガーを別に足す。
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS loan_orders_block_cancel_with_returns ON loan_orders;
--   DROP FUNCTION IF EXISTS enforce_loan_order_cancellable();

CREATE OR REPLACE FUNCTION enforce_loan_order_cancellable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- 取り消しへ進むときだけ見る。ほかの状態変化・すでに取り消し済みの行は素通しする
  IF NEW.status <> 'cancelled' OR OLD.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.loan_returns lr
    WHERE lr.status <> 'cancelled'
      AND (
        lr.loan_order_id = NEW.id
        OR EXISTS (
          SELECT 1
          FROM public.loan_return_items lri
          JOIN public.loan_order_items loi ON loi.id = lri.loan_order_item_id
          WHERE lri.loan_return_id = lr.id
            AND lri.status <> 'cancelled'
            AND loi.loan_order_id = NEW.id
        )
      )
  ) THEN
    RAISE EXCEPTION 'loan order % has active returns; cancel the returns first', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION enforce_loan_order_cancellable() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION enforce_loan_order_cancellable() IS
  '返却が残っている短貸発注を取り消せなくする（I-022、2026-09-09 の業務判断）。先に返却を取り消す';

DROP TRIGGER IF EXISTS loan_orders_block_cancel_with_returns ON loan_orders;
CREATE TRIGGER loan_orders_block_cancel_with_returns
  BEFORE UPDATE OF status ON loan_orders
  FOR EACH ROW EXECUTE FUNCTION enforce_loan_order_cancellable();

-- テーブルの新設・削除ではないため refresh_schema_baseline_snapshot の呼び出しは不要。
