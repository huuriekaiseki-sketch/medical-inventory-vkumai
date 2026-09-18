-- supabase/migrations/20260907000003_add_foreign_key_indexes.sql
-- issue #757 の 19（性能と上限）。索引の穴は scripts/check-foreign-key-indexes.test.sh が固定する。
-- release-order: db-first
-- lock: 索引 10 本の作成中、対象表（明細 4 表・消耗品・代理店商品）への書き込みが止まる。
--       ローカルの実測は 36,000 行で約 40 ms だが、本番のデータ量は未計測。
--       CREATE INDEX CONCURRENTLY は migration がトランザクション内で走るため使えないので、
--       利用の少ない時間帯に当てる（docs/agents/performance-baseline.md）。
--
-- WHY: PostgreSQL は外部キーを作っても**参照する側**に索引を作らない。索引が無いと、
--      親を 1 行消すたびに子テーブル全体を走査して参照行を探す。行数に比例した走査が
--      親の行数だけ繰り返されるので、施設削除のような CASCADE は行数の二乗で重くなる。
--
--      2026-09-07 にローカルで実測した（1 施設・症例発注と明細だけの単純な形）:
--        発注 3,000 / 明細 3,000  → 施設削除 547 ms
--        発注 6,000 / 明細 18,000 → 施設削除 2,863 ms
--        発注 12,000 / 明細 36,000 → **statement timeout で削除できない**
--      つまり、ある程度使った施設は「消せない」状態になっていた（#757 の 12 が
--      規模で壊れる）。一覧の取得（facility_id + created_at の複合索引あり）は
--      12,000 件でも 3 ms で、遅いのは削除だけだった。
--
--      対象は「索引の無い外部キー列」すべて。明細 4 表の親 ID、消耗品明細の消耗品 ID、
--      JAN の 4 経路（products(jan) を消すときに走査される）。
--
-- WHY(CONCURRENTLY を使わない): migration はトランザクション内で走るため
--      CREATE INDEX CONCURRENTLY は使えない。本番のデータ量では作成中に書き込みが
--      止まるので、適用は利用の少ない時間帯に行う（docs/agents/release-safety-runbook.md）。
--      対象表は現状どれも小さく、ローカルでは 36,000 行で 40 ms 程度だった。
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_case_order_items_case_order_id;
--   DROP INDEX IF EXISTS idx_case_order_items_jan;
--   DROP INDEX IF EXISTS idx_consumable_order_items_consumable_order_id;
--   DROP INDEX IF EXISTS idx_consumable_order_items_consumable_id;
--   DROP INDEX IF EXISTS idx_loan_order_items_loan_order_id;
--   DROP INDEX IF EXISTS idx_loan_order_items_jan;
--   DROP INDEX IF EXISTS idx_loan_return_items_loan_return_id;
--   DROP INDEX IF EXISTS idx_loan_return_items_jan;
--   DROP INDEX IF EXISTS idx_consumables_jan;

-- 明細 4 表の親 ID（施設削除・発注削除の CASCADE と、明細一覧の絞り込みで使う）
CREATE INDEX IF NOT EXISTS idx_case_order_items_case_order_id
  ON case_order_items (case_order_id);
CREATE INDEX IF NOT EXISTS idx_consumable_order_items_consumable_order_id
  ON consumable_order_items (consumable_order_id);
CREATE INDEX IF NOT EXISTS idx_loan_order_items_loan_order_id
  ON loan_order_items (loan_order_id);
CREATE INDEX IF NOT EXISTS idx_loan_return_items_loan_return_id
  ON loan_return_items (loan_return_id);

-- 消耗品明細 → 消耗品（施設削除で consumables が消えるときに走査される）
CREATE INDEX IF NOT EXISTS idx_consumable_order_items_consumable_id
  ON consumable_order_items (consumable_id);

-- 代理店商品 → 商品（products を消すと ON DELETE CASCADE で連鎖する。
-- さらに distributor_products の削除が hospital_prices へ連鎖するので、ここが詰まると
-- マスタ整理そのものが止まる）
CREATE INDEX IF NOT EXISTS idx_distributor_products_product_id
  ON distributor_products (product_id);

-- JAN の参照側（products(jan) を消すときに走査される。マスタ削除は admin + aal2 だけができる）
CREATE INDEX IF NOT EXISTS idx_case_order_items_jan ON case_order_items (jan);
CREATE INDEX IF NOT EXISTS idx_loan_order_items_jan ON loan_order_items (jan);
CREATE INDEX IF NOT EXISTS idx_loan_return_items_jan ON loan_return_items (jan);
CREATE INDEX IF NOT EXISTS idx_consumables_jan ON consumables (jan);
