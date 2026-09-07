-- supabase/migrations/20260907060000_add_products_name_length_limit.sql
-- lock: CHECK の追加。NOT VALID にしているので既存行の再検査をせず、表を長くロックしない
--       （既存行の違反 0 件は夜間検査 I-066 で確かめてから VALIDATE する）
-- issue #757 の 20。不変条件 I-065 の取りこぼし。
-- release-order: db-first
--
-- WHY: 2026-09-07 に `scripts/lib/scan-text-columns.mjs` のバグを直したところ、
--      **`products.name` に長さの上限が無い**ことが分かった。
--      20260907000004 の `products_text_length` は `jan` と `ref` しか見ておらず、
--      名称が抜けていた。不変条件カタログ I-065 は「マスタの JAN と品番は 64 文字以内、
--      名称・メーカー・仕入先は 200 文字以内」と書いてあったので、**宣言と実装がずれていた**。
--
--      見つからなかった理由: 走査が CREATE TABLE 内のインライン CHECK を**列名だけ**で持っていて、
--      `categories.name` と `distributor_products.name` に付いている `length(name) <= 200` が
--      `products.name` まで「上限あり」に見せていた。表をまたいだ誤判定で穴が隠れていた。
--
--      `products` は admin が API から書けるマスタ（P-021）なので、上限が無いと
--      画面の maxlength を通らない経路から任意長の文字列が入る（術式名で 1 MB が入った実績がある）。
--
-- WHY(maker も同時に塞ぐ): 走査を直す過程で**もう 1 つのバグ**が出た。
--      `ALTER TABLE products ADD COLUMN name TEXT, ADD COLUMN maker TEXT;` のように
--      1 文に ADD COLUMN が複数あると、**2 つ目以降を拾えていなかった**
--      （2 つ目の前に `alter table` が無いため）。そのため `products.maker` は
--      「上限がある / 無い」以前に**走査に一度も出ていなかった**。
--      走査を直したら unguarded に現れたので、ここで一緒に塞ぐ。
--      値は I-065 と揃えて 200 文字（aidd.config.json の limits.textLength.name）。
--
-- ROLLBACK:
--   ALTER TABLE products DROP CONSTRAINT products_name_length;
--   ALTER TABLE products DROP CONSTRAINT products_maker_length;

ALTER TABLE products
  ADD CONSTRAINT products_name_length CHECK (length(name) <= 200) NOT VALID;

ALTER TABLE products
  ADD CONSTRAINT products_maker_length CHECK (maker IS NULL OR length(maker) <= 200) NOT VALID;
