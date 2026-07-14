-- supabase/migrations/20260714000004_orders_history_prereqs.sql
--
-- WHY: issue #20（発注履歴ページ新設）SPEC.md Part2 Set A。
--
-- 1. loan_returns に loan_order_id を追加する。
--    現状 loan_returns は loan_orders と紐づいておらず、「この短貸発注は返却済みか」を
--    判定できない（=「未返却」バッジが実装不能）。NOT NULL にはしない。既存の loan_returns
--    行は対応する loan_order を後から追跡できないため、NULL 許容のままにして後方互換を保つ。
-- 2. consumable_orders / loan_orders / loan_returns の一覧取得（横断発注履歴・created_at降順）
--    で使う (facility_id, created_at DESC) の複合インデックスが無かったため追加する。
--
-- このmigrationはpublicスキーマのテーブル構成（追加/削除）を変更しない
-- （列追加・インデックス追加のみ）ため、refresh_schema_baseline_snapshot() の呼び出しは不要。
-- （docs/agents/common.md: 「publicスキーマのテーブルを追加/削除するmigration」が対象であり、
--   check_schema_drift() も pg_tables の一覧比較のみを見るため、列追加はドリフト検知対象外）

ALTER TABLE loan_returns
  ADD COLUMN loan_order_id UUID REFERENCES loan_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_consumable_orders_facility_created_at
  ON consumable_orders (facility_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loan_orders_facility_created_at
  ON loan_orders (facility_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loan_returns_facility_created_at
  ON loan_returns (facility_id, created_at DESC);
