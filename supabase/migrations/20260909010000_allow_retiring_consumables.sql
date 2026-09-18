-- supabase/migrations/20260909010000_allow_retiring_consumables.sql
-- release-order: db-first
-- design: 権限=施設の writer（登録できる人が直せる・止められる人。RLS は既存の
--         facility_writer_or_admin のまま）／大きさ・量は変えない（列を 1 つ足すだけ）／
--         消えるとき=**発注実績が無ければ行ごと消え、あれば使用停止として残る**（人の判断、2026-09-09）／
--         記録=既存の監査トリガーが status の変更と削除を残す／外部送信なし
-- lock: 既定値が定数の列追加は書き換えを伴わない（PostgreSQL 11 以降はカタログだけを書き換える）。
--       ACCESS EXCLUSIVE は取るが行数に依らず一瞬で終わる。
--       実測: `consumables` は 2026-09-09 時点で **0 行**（手元の DB を作り直した直後のため）で、
--       **この数字は根拠として弱い**ので行数に依らない理由を併記する。
--       CHECK は列と同時に付けるので既存行の全件検証は起きない
-- cardinality: many
--
-- WHY(E-055 / E-056 と同じ形): 消耗品は**作成と一覧しかできなかった**。
--      名前を打ち間違えても直せず、廃番になっても発注の選択肢に残り続ける。
--      いっぽう DB は施設の writer に UPDATE / DELETE を許していて（facility_writer_or_admin は
--      FOR ALL）、**層が食い違っていた**（実測）。E-055（触れるが何も起きない道）の裏返しで、
--      こちらは「DB は許しているのに製品の中に道が無い」形。
--
-- WHY(削除と使用停止を使い分ける): 人の判断（2026-09-09）。
--      `consumable_order_items.consumable_id` は `consumables(id)` への外部キーで
--      ON DELETE を指定していないため、**発注実績がある消耗品は DB が削除を拒否する**（23503）。
--      それを利用者に「エラー」として見せるのではなく、
--        - 実績が無い（＝登録ミス）→ 行ごと消す。跡形も残さない
--        - 実績がある（＝廃番）→ `retired` にして一覧と発注の選択肢から外す。過去の発注は残る
--      と読み替える。**消し方を 1 つに決めないのは、2 つの状況が本当に別物だから**。
--
-- WHY(status を足す。is_active のような真偽値にしない): 発注・返却が `status` で状態を持つのと
--      揃える。真偽値にすると「なぜ止めたか」を後から足す場所が無く、語彙を増やすときに列が増える。
--
-- ROLLBACK:
--   -- 先にトリガーを外す（外さないと `retired` から戻す UPDATE を自分で拒む）
--   DROP TRIGGER IF EXISTS consumables_status_forward_only ON consumables;
--   ALTER TABLE consumables DROP COLUMN status;
--   -- 明細のトリガーは 20260909000000 の形（列を指定しない BEFORE UPDATE）へ戻す
--   DROP TRIGGER IF EXISTS loan_return_items_status_forward_only ON loan_return_items;
--   CREATE TRIGGER loan_return_items_status_forward_only
--     BEFORE UPDATE ON loan_return_items
--     FOR EACH ROW EXECUTE FUNCTION enforce_status_forward_only();
--   -- 共有している関数を 20260908060000 の版へ戻す（終端は 'cancelled' のみ）
--   CREATE OR REPLACE FUNCTION enforce_status_forward_only()
--   RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
--   BEGIN
--     IF OLD.status IS DISTINCT FROM NEW.status THEN
--       IF OLD.status = 'cancelled' THEN
--         RAISE EXCEPTION 'status cannot leave cancelled (tried % to %)', OLD.status, NEW.status
--           USING ERRCODE = 'check_violation';
--       ELSIF NEW.status = 'cancelled' THEN
--         NULL;
--       ELSIF OLD.status <> 'draft' THEN
--         RAISE EXCEPTION 'status cannot go back from % to %', OLD.status, NEW.status
--           USING ERRCODE = 'check_violation';
--       END IF;
--     END IF;
--     RETURN NEW;
--   END;
--   $$;

ALTER TABLE consumables
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'retired'));

COMMENT ON COLUMN consumables.status IS
  '使用停止（2026-09-09）。retired は一覧と発注の選択肢から外れるが、過去の発注は残る';

-- =========================================================================
-- 状態は前にしか進まない（I-020）に、終端の語彙として `retired` を足す
--
-- WHY(付けるだけでは進めなかった・実測 2026-09-09): この関数は
--      「`draft` からしか動かせない。ただし `cancelled` へはいつでも進める」という形だった。
--      消耗品は `active` で生まれるので、**トリガーを付けただけでは
--      `active` → `retired` が `status cannot go back from active to retired` で拒まれる**。
--      統合テストで測って初めて分かった（「汎用だからそのまま付く」は思い込みだった）。
--
-- WHY(表ごとに関数を分けない): 「状態は戻らない」という約束の置き場所を 1 か所に保つ。
--      どの語彙をその表が持てるかは**表ごとの CHECK** が決めるので、
--      ここに `retired` を足しても、`retired` を CHECK に持たない表（発注 3 種・返却）では
--      CHECK が先に弾く。**語彙を持つ表だけがその終端へ行ける**という既存の形と同じ。
--
-- WHY(最後に定義した版を元にする・E-064): この関数は
--      20260906000003 → 20260908060000 と 2 回定義されている。ここでは
--      20260908060000（取り消しを終端にした版）を元に、終端の集合を 1 つ広げただけで、
--      `SET search_path = ''` と check_violation の投げ方はそのまま残している。
--
-- ROLLBACK 時は 20260908060000 の版に戻す（終端は 'cancelled' のみ）。
-- =========================================================================
CREATE OR REPLACE FUNCTION enforce_status_forward_only()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status IN ('cancelled', 'retired') THEN
      RAISE EXCEPTION 'status cannot leave % (tried % to %)', OLD.status, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    ELSIF NEW.status IN ('cancelled', 'retired') THEN
      NULL;  -- 終端へはいつでも進める（取り消し・使用停止）
    ELSIF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'status cannot go back from % to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- WHY(止めたら戻せない): 発注・返却の取り消しと同じ規則を掛ける。
--      上の関数により `active` からは `retired` へしか動かせず、`retired` からは動かせない。
--
--      **戻したくなったら新しく登録する**（同じ名前で作り直せる）。
--      「止めたものが復活する」と、過去のどの時点で選べたのかが分からなくなる。
DROP TRIGGER IF EXISTS consumables_status_forward_only ON consumables;
CREATE TRIGGER consumables_status_forward_only
  BEFORE UPDATE OF status ON consumables
  FOR EACH ROW EXECUTE FUNCTION enforce_status_forward_only();

-- WHY(明細の分も同じ形に揃える): 20260909000000 で足した `loan_return_items` のトリガーだけ
--      `BEFORE UPDATE`（列を指定しない形）で、他の 5 表と食い違っていた。
--      振る舞いは同じ（関数が OLD/NEW を見る）が、**不変条件カタログ I-020 は
--      「BEFORE UPDATE OF status」と書いてある**ので、宣言と実態を揃える（C-010）。
--      列を指定すると status を触らない UPDATE でトリガーが動かない分だけ無駄も減る。
DROP TRIGGER IF EXISTS loan_return_items_status_forward_only ON loan_return_items;
CREATE TRIGGER loan_return_items_status_forward_only
  BEFORE UPDATE OF status ON loan_return_items
  FOR EACH ROW EXECUTE FUNCTION enforce_status_forward_only();

-- テーブルの新設・削除ではないため refresh_schema_baseline_snapshot の呼び出しは不要。
