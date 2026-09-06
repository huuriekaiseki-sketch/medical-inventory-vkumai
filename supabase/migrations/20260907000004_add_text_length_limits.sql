-- supabase/migrations/20260907000004_add_text_length_limits.sql
-- issue #757 の 20（入力検証）と 32（悪用耐性）。不変条件カタログ I-060〜I-069。
-- release-order: db-first
--
-- WHY: 自由入力の TEXT 列に長さの上限が 1 つも無かった。2026-09-07 の実測では、
--      症例発注の術式名に **1 MB の文字列がそのまま保存された**（施設名 200,000 文字、
--      JAN 5,000 文字も同じ）。害は 3 つある:
--        1. 保管量: 1 行で MB 単位になる。監査ログ（old_data / new_data）が同じものを 2 重に持つので、
--           1 回の更新で数 MB 増える
--        2. 画面: 一覧に 1 MB の文字列を出すと描画が固まる
--        3. 上限の不在そのもの: 正規の権限を持つ利用者が「何回やれるか」の上限も持たないため
--           （quota-inventory の Q-011）、量で困らせる経路が開いている
--
--      画面側の maxlength は利便性であって防御ではない（API を直接叩けば通る）。
--      不変条件は DB が守る（invariant-catalog の方針）。アプリは 23514 を
--      src/lib/invariant-error.ts で一文に写像するだけ。
--
-- WHY(値の決め方): 実データの最大長を見て、その 10 倍以上を上限にした（実運用を邪魔しない）。
--      名前・術式名・メーカー名は 200、患者 ID とロットは 100、イニシャルと性別は 20、
--      JAN と品番は 64、用途・備考は 1,000。**画面の入力欄を狭めるための値ではない**。
--
-- WHY(NOT VALID): 既存行を全部読むと、その表への書き込みが止まる（#757-18）。
--      NOT VALID で入れて、既存行の違反 0 件を夜間検査（I-051）で確認してから
--      別 migration で VALIDATE CONSTRAINT する（expand → validate）。
--
-- ROLLBACK:
--   ALTER TABLE case_orders DROP CONSTRAINT case_orders_text_length;（他の表も同様）
--   すべて DROP CONSTRAINT で戻せる。データは変えていない。

-- 症例発注
ALTER TABLE case_orders
  ADD CONSTRAINT case_orders_text_length CHECK (
    length(procedure_name) <= 200
    AND length(patient_id) <= 100
    AND length(patient_initials) <= 20
    AND length(doctor_name) <= 100
  ) NOT VALID;

-- 短貸発注
ALTER TABLE loan_orders
  ADD CONSTRAINT loan_orders_text_length CHECK (
    length(procedure_name) <= 200
    AND length(maker) <= 200
  ) NOT VALID;

-- 明細（JAN・ロット・使用期限・品名）
ALTER TABLE case_order_items
  ADD CONSTRAINT case_order_items_text_length CHECK (
    length(jan) <= 64
    AND (lot IS NULL OR length(lot) <= 100)
    AND (ubd IS NULL OR length(ubd) <= 100)
  ) NOT VALID;

ALTER TABLE loan_order_items
  ADD CONSTRAINT loan_order_items_text_length CHECK (
    (jan IS NULL OR length(jan) <= 64)
    AND length(name) <= 200
  ) NOT VALID;

ALTER TABLE loan_return_items
  ADD CONSTRAINT loan_return_items_text_length CHECK (
    length(jan) <= 64
    AND (lot IS NULL OR length(lot) <= 100)
    AND (ubd IS NULL OR length(ubd) <= 100)
  ) NOT VALID;

-- 消耗品
ALTER TABLE consumables
  ADD CONSTRAINT consumables_text_length CHECK (
    length(name) <= 200
    AND (jan IS NULL OR length(jan) <= 64)
    AND length(purpose) <= 1000
  ) NOT VALID;

-- 施設
ALTER TABLE facilities
  ADD CONSTRAINT facilities_text_length CHECK (length(name) <= 200) NOT VALID;

-- マスタ（商品・カテゴリ・代理店商品）
ALTER TABLE products
  ADD CONSTRAINT products_text_length CHECK (
    length(jan) <= 64
    AND length(ref) <= 64
  ) NOT VALID;

ALTER TABLE categories
  ADD CONSTRAINT categories_text_length CHECK (length(name) <= 200) NOT VALID;

ALTER TABLE distributor_products
  ADD CONSTRAINT distributor_products_text_length CHECK (
    length(maker) <= 200
    AND length(supplier) <= 200
    AND length(name) <= 200
  ) NOT VALID;
-- （category 列は 20260620000000 でカテゴリ表への FK に置き換わっているので対象外）
