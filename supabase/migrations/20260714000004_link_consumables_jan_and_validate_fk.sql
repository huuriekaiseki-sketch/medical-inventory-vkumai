-- supabase/migrations/20260714000004_link_consumables_jan_and_validate_fk.sql
-- issue #26: consumables.jan が products と未紐付けだった問題の解消。
-- あわせて 20260626000000 で NOT VALID のまま残っていた jan FK 群を検証する。
-- すべて冪等（再実行しても失敗しない）に記述する。

-- =========================================================================
-- 1. consumables.jan を products(jan) への FK にする。
--    既存データに孤児 jan があっても適用できるよう NOT VALID で追加する
--    （20260626000000 の case_order_items 等と同じ方針）。
-- =========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'consumables_jan_fkey'
  ) THEN
    ALTER TABLE consumables
      ADD CONSTRAINT consumables_jan_fkey
        FOREIGN KEY (jan) REFERENCES products (jan) NOT VALID;
  END IF;
END
$$;

-- =========================================================================
-- 2. NOT VALID のまま残っていた jan FK を検証する。
--    VALIDATE CONSTRAINT は対象行を読むだけでテーブル全体をロックしないため、
--    運用中のテーブルに対しても安全に実行できる。
--    既存データに孤児 jan が残っている場合はここで失敗する
--    （サイレントに無視せず、データ修正が必要なことを明示するため意図的な挙動）。
-- =========================================================================
ALTER TABLE case_order_items VALIDATE CONSTRAINT case_order_items_jan_fkey;
ALTER TABLE loan_order_items VALIDATE CONSTRAINT loan_order_items_jan_fkey;
ALTER TABLE loan_return_items VALIDATE CONSTRAINT loan_return_items_jan_fkey;
ALTER TABLE consumables VALIDATE CONSTRAINT consumables_jan_fkey;
