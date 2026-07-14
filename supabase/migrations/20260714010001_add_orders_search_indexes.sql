-- supabase/migrations/20260714010001_add_orders_search_indexes.sql
-- WHY: issue #20（発注履歴ページ /orders）の期間フィルタが、各テーブルの日時カラム
--      （case_orders.case_datetime / consumable_orders.created_at / loan_orders.created_at /
--      loan_returns.return_datetime）で絞り込むため、facility_id との複合インデックスを追加する。
--      case_orders は既存の idx_case_orders_facility_created_at（facility_id, created_at）とは
--      別カラム（case_datetime）での絞り込みのため、新規インデックスが別途必要（SPEC.md Part2 SET-A）。
--
-- refresh_schema_baseline_snapshot は呼ばない: このマイグレーションはインデックス追加のみで
-- テーブルの追加/削除を伴わないため、docs/agents/common.md記載のスキーマドリフト検知baseline
-- 更新の対象外（20260714000003_schema_drift_v1_hardening.sql 参照）。

CREATE INDEX IF NOT EXISTS idx_case_orders_facility_case_datetime
  ON case_orders (facility_id, case_datetime);

CREATE INDEX IF NOT EXISTS idx_consumable_orders_facility_created_at
  ON consumable_orders (facility_id, created_at);

CREATE INDEX IF NOT EXISTS idx_loan_orders_facility_created_at
  ON loan_orders (facility_id, created_at);

CREATE INDEX IF NOT EXISTS idx_loan_returns_facility_return_datetime
  ON loan_returns (facility_id, return_datetime);
