-- supabase/migrations/20260714224053_create_product_compatibilities.sql
--
-- WHY: issue #21（コンパチ（互換品）ページの実体化）SPEC.md Part2 Set A。
--
-- 「コンパチ」ページ（/compat）で、同一カテゴリ内の複数製品（JAN単位）が
-- 互いに代替品として使用可能かどうかを登録・検索できるようにするため、
-- product_compatibilities テーブルを新設する。
--
-- 人間レビューで確定した設計方針（SPEC.md参照）:
-- 1. 施設スコープ: 単一共有マスタ（互換性は製品仕様上の客観的事実であり、
--    施設ごとの運用判断ではないため。facility_idは持たない＝テナント非分離）
-- 2. CASCADE削除: 他マスタ（products/categories/distributor_products）と
--    同じ物理削除+CASCADEパターンに揃える（論理削除化は別途検討）
-- 3. UPDATE(備考編集)を許容するため RLS は FOR ALL のまま
--    （備考の入力ミス訂正需要があり、admin限定で既に保護されているため
--    INSERT/DELETEに絞る実益は薄いと判断）
--
-- product_id_1 < product_id_2 の CHECK 制約により、(a,b) と (b,a) を同一視する。
-- 挿入前にリポジトリ層(src/lib/compatibilities/repository.ts)でUUID文字列を比較し
-- 小さい方を product_id_1 に正規化する必要がある（本migrationはその前提のDB制約のみ）。

CREATE TABLE product_compatibilities (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid        NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  product_id_1 uuid       NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_id_2 uuid       NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- 自己参照禁止
  CONSTRAINT no_self_compat CHECK (product_id_1 <> product_id_2),
  -- UUID文字列の辞書順で小さい方を必ず product_id_1 に入れる → (a,b)と(b,a)を同一視
  CONSTRAINT ordered_pair  CHECK (product_id_1 < product_id_2),
  -- 同カテゴリ内でのペア重複禁止
  UNIQUE (category_id, product_id_1, product_id_2)
);

CREATE TRIGGER product_compatibilities_updated_at
  BEFORE UPDATE ON product_compatibilities
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

GRANT ALL ON TABLE public.product_compatibilities TO postgres, anon, authenticated, service_role;

-- インデックス戦略（category_id・product_id_1/2 に対するFK/絞り込み用。
-- keyword検索は products.name/jan/maker に対するJOIN後の.ilikeであり、
-- このインデックスでは加速されない。マスタ件数が少ない前提のためGIN/pg_trgmは初期実装では未導入）
CREATE INDEX idx_compat_category_id  ON product_compatibilities (category_id);
CREATE INDEX idx_compat_product_id_1 ON product_compatibilities (product_id_1);
CREATE INDEX idx_compat_product_id_2 ON product_compatibilities (product_id_2);

-- RLS（products/categories/distributor_products と同じマスタテーブルパターン。
-- 本機能はテナント非分離＝施設スコープなし）
ALTER TABLE product_compatibilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "compat_select" ON product_compatibilities FOR SELECT TO authenticated USING (true);
CREATE POLICY "compat_write"  ON product_compatibilities FOR ALL    TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- refresh_schema_baseline_snapshot 呼び出し（issue #305要件・テーブル新設のため必須）
SELECT refresh_schema_baseline_snapshot('20260714224053');
