-- supabase/migrations/20260715000001_add_unit_price_to_order_items.sql
-- issue #23 Part2 Set A: 発注明細に単価スナップショット用カラムを追加する。
-- WHY: 過去発注の金額を「発注時点の単価」で再現できるようにするため
--      （現在のhospital_pricesをJOINして計算する方式は履歴精度が失われるため不採用）。

ALTER TABLE case_order_items       ADD COLUMN unit_price NUMERIC(12,2);
ALTER TABLE consumable_order_items ADD COLUMN unit_price NUMERIC(12,2);
ALTER TABLE loan_order_items       ADD COLUMN unit_price NUMERIC(12,2);

-- 既存データはNULL（過去発注は金額データなし、未解決事項7で確定）。カラム追加のみで
-- テーブル新設/削除ではないため refresh_schema_baseline_snapshot は不要（issue #305要件の対象外）。

-- WHY(重複・過剰実装指摘対応): 当初SPEC.mdは「20260714000005_orders_history_prereqs.sqlが
-- consumable_orders/loan_orders/loan_returnsの(facility_id, created_at)複合インデックスを
-- 追加済みだが、case_ordersが欠落している」という前提でCREATE INDEXを追加していたが、この前提は
-- 誤りだった。case_ordersには20260626000000_fix_fk_and_indexes.sqlで既に
-- idx_case_orders_facility_created_at ON case_orders (facility_id, created_at) が作成済みであり、
-- 同名インデックスをCREATE INDEX IF NOT EXISTSで再作成しようとしても既存インデックス名と衝突して
-- 静かにno-opになる（DESC指定が実際には反映されない死んだ文になっていた）。
-- btreeインデックスは昇順・降順どちらの範囲検索・ORDER BYにも双方向で使えるため、DESC無しの
-- 既存インデックスで本レポート機能（WHERE created_at範囲 + GROUP BY facility_id）の要件は
-- 満たされる。よって本migrationでは重複するインデックス作成を行わない。
