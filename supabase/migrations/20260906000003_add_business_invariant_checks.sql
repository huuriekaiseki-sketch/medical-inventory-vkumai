-- supabase/migrations/20260906000003_add_business_invariant_checks.sql
-- issue #757 の 3（業務不変条件のカタログ）。正本は docs/agents/invariant-catalog.md（I-xxx）。
--
-- WHY: 「数量は 1 以上」「金額は 0 以上」「発注の状態は戻らない」は仕様書と画面の入力検証にしか無く、
--      RPC や service_role、Studio から直接書くと壊せた。約束を DB 制約に落とし、破る操作が
--      どの経路からでも拒否されるようにする。判定ロジックを持つのは DB だけにし、アプリ側は
--      23514（check_violation）を利用者向けメッセージに写像するだけにする。
--
-- WHY(NOT VALID): 既存行に違反があっても migration を失敗させず（本番の初期化・適用を止めない）、
--      新しい書き込みだけを止める。既存行の検査は夜間 SELECT（#757 の 9）で行い、0 件を確認したら
--      別 migration で VALIDATE CONSTRAINT する（expand → validate の 2 段）。
--      NOT VALID でも INSERT / UPDATE の検査は即座に効く（PostgreSQL の仕様）。

-- I-010 発注明細の数量は 1 以上
ALTER TABLE case_order_items       ADD CONSTRAINT case_order_items_quantity_positive       CHECK (quantity > 0) NOT VALID;
ALTER TABLE consumable_order_items ADD CONSTRAINT consumable_order_items_quantity_positive CHECK (quantity > 0) NOT VALID;
ALTER TABLE loan_order_items       ADD CONSTRAINT loan_order_items_quantity_positive       CHECK (quantity > 0) NOT VALID;
-- I-011 返却明細の数量は 1 以上
ALTER TABLE loan_return_items      ADD CONSTRAINT loan_return_items_quantity_positive      CHECK (quantity > 0) NOT VALID;

-- I-012 明細の単価スナップショットは 0 以上（NULL = 金額データなし、は許す）
ALTER TABLE case_order_items       ADD CONSTRAINT case_order_items_unit_price_nonnegative       CHECK (unit_price IS NULL OR unit_price >= 0) NOT VALID;
ALTER TABLE consumable_order_items ADD CONSTRAINT consumable_order_items_unit_price_nonnegative CHECK (unit_price IS NULL OR unit_price >= 0) NOT VALID;
ALTER TABLE loan_order_items       ADD CONSTRAINT loan_order_items_unit_price_nonnegative       CHECK (unit_price IS NULL OR unit_price >= 0) NOT VALID;

-- I-013 施設別価格の仕切値・納品価格は 0 以上
ALTER TABLE hospital_prices ADD CONSTRAINT hospital_prices_prices_nonnegative CHECK (purchase_price >= 0 AND delivery_price >= 0) NOT VALID;

-- I-014 代理店商品の入数は 1 以上、償還価格は 0 以上（NULL 可）
ALTER TABLE distributor_products ADD CONSTRAINT distributor_products_quantity_positive            CHECK (quantity > 0) NOT VALID;
ALTER TABLE distributor_products ADD CONSTRAINT distributor_products_reimbursement_price_nonnegative CHECK (reimbursement_price IS NULL OR reimbursement_price >= 0) NOT VALID;

-- I-020 状態は前にしか進まない（draft → submitted / returned）。draft 以外からの変更は拒否
-- WHY(トリガー): CHECK は OLD を見られない。RETURNS TRIGGER なので RPC としては公開されない
--      （P-043 の判定対象外）。ERRCODE を check_violation にして、アプリの 23514 写像に乗せる。
CREATE OR REPLACE FUNCTION enforce_status_forward_only()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'status cannot go back from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER case_orders_status_forward_only
  BEFORE UPDATE OF status ON case_orders
  FOR EACH ROW EXECUTE FUNCTION enforce_status_forward_only();
CREATE TRIGGER consumable_orders_status_forward_only
  BEFORE UPDATE OF status ON consumable_orders
  FOR EACH ROW EXECUTE FUNCTION enforce_status_forward_only();
CREATE TRIGGER loan_orders_status_forward_only
  BEFORE UPDATE OF status ON loan_orders
  FOR EACH ROW EXECUTE FUNCTION enforce_status_forward_only();
CREATE TRIGGER loan_returns_status_forward_only
  BEFORE UPDATE OF status ON loan_returns
  FOR EACH ROW EXECUTE FUNCTION enforce_status_forward_only();

-- ROLLBACK:
--   DROP TRIGGER case_orders_status_forward_only ON case_orders;（他 3 表も同様）
--   DROP FUNCTION enforce_status_forward_only();
--   ALTER TABLE <表> DROP CONSTRAINT <制約名>;（上の 10 本）

-- テーブル新設/削除ではないため refresh_schema_baseline_snapshot の呼び出しは不要。
