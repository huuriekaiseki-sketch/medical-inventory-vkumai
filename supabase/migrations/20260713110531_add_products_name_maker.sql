-- 在庫マスタのカラム追加: products に name（製品名・必須）/ maker（メーカー名・任意）を追加
-- WHY: SPEC.md Part2 Set A の実装計画に従い、既存レコードは DEFAULT '' で移行し、
--      maker は任意フィールドのため NULL 許可のままにする。
--      products テーブルは施設スコープを持たないため RLS ポリシー変更は不要。
ALTER TABLE products
  ADD COLUMN name  TEXT NOT NULL DEFAULT '',
  ADD COLUMN maker TEXT;
