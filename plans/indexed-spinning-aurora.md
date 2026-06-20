# 実装計画: 販売店商品管理UI + カテゴリ管理

## Context

`distributor_products` テーブルとAPIは実装済みだがUIが存在しない。
加えて、`category` フィールドが現在フリーテキストのため、`categories` マスタテーブルを新設してDB管理に切り替える。

## 確定した仕様（grill-me 結果）

| 項目 | 決定内容 |
|------|----------|
| カテゴリ入力 | `categories` テーブルからセレクト |
| カテゴリ管理 | 独立ページ `/categories`（CRUD） |
| カテゴリフィールド | `id`, `name`, `description` |
| カテゴリ削除 | 使用中（distributor_productsに紐付き）は削除不可 |
| 製品セレクト表示 | `jan / ref` |
| ナビ追加 | 「販売店商品」→ デバイスの隣 / 「カテゴリ」→ その他ページ内にリンク |

---

## DB変更（マイグレーション）

新規マイグレーションファイル: `supabase/migrations/YYYYMMDD_add_categories.sql`

```sql
-- categoriesテーブル新設
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER update_categories_updated_at
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- distributor_products.category(text) → category_id(uuid FK)
ALTER TABLE distributor_products
  ADD COLUMN category_id uuid REFERENCES categories(id);

ALTER TABLE distributor_products
  DROP COLUMN category;

ALTER TABLE distributor_products
  ALTER COLUMN category_id SET NOT NULL;
```

---

## 型変更

**`src/types/category.ts`**（新規）
```
Category: { id, name, description, createdAt, updatedAt }
CategoryInput: { name, description }
```

**`src/types/distributorProduct.ts`**（変更）
- `category: string` → `categoryId: string`（DistributorProduct・DistributorProductInput両方）

---

## 並列実装グループ

### Wave 0（前提・逐次・親が担当）
- DBマイグレーション実行
- `src/lib/distributor-products/repository.ts` の `category` → `category_id` 対応
- `src/types/distributorProduct.ts` の型更新

### Wave 1（同時実装可）

**セット A** — `src/lib/categories/repository.ts`（新規）+ `src/types/category.ts`（新規）
- `listCategories()`, `getCategory(id)`, `createCategory(input)`, `updateCategory(id, input)`, `deleteCategory(id)`
- 削除時: distributor_productsにcategory_idが存在すれば `Error('使用中のため削除できません')` を throw

**セット B** — `src/app/api/categories/route.ts` + `src/app/api/categories/[id]/route.ts`（新規）
- GET/POST/GET[id]/PUT[id]/DELETE[id]
- DELETE[id]: 409 で「使用中のため削除できません」

**セット C** — `src/components/distributor-products/DistributorProductList.tsx`（新規）
- props: `items`, `onEdit`, `onDelete`
- 空状態メッセージあり

**セット D** — `src/components/distributor-products/DistributorProductForm.tsx`（新規）
- props: `products`, `categories`, `defaultValues?`, `onSubmit`, `submitLabel?`, `submitError?`
- 製品セレクト: `${product.jan} / ${product.ref}`
- カテゴリセレクト: categoriesから取得
- reimbursementPrice: 空欄 → null
- quantity: min=1, step=1

**セット E** — `src/components/categories/CategoryList.tsx` + `src/components/categories/CategoryForm.tsx`（新規）
- CategoryList props: `categories`, `onEdit`, `onDelete`
- CategoryForm props: `defaultValues?`, `onSubmit`, `submitLabel?`, `submitError?`
- フィールド: name（必須）、description（任意）

### Wave 2（Wave 1完了後・同時実装可）

**セット F** — `/distributor-products` ページ群（新規）
- `src/app/distributor-products/page.tsx`
- `src/app/distributor-products/new/page.tsx`（products + categories を並列fetch）
- `src/app/distributor-products/[id]/edit/page.tsx`（item + products + categories を並列fetch）

**セット G** — `/categories` ページ群（新規）
- `src/app/categories/page.tsx`
- `src/app/categories/new/page.tsx`
- `src/app/categories/[id]/edit/page.tsx`

### 統合ゲート（Wave 2完了後・逐次）

**セット H** — `src/app/layout.tsx`（変更）
- 「販売店商品」リンク（`/distributor-products`）を「デバイス」の隣に追加

**セット I** — `src/app/other/page.tsx`（変更）
- 「カテゴリ管理」→ `/categories` へのリンクを追加

---

## 参照すべき既存ファイル

| 参照元 | 用途 |
|--------|------|
| `src/components/products/ProductList.tsx` | Listコンポーネントのパターン |
| `src/components/hospitalPrices/HospitalPriceForm.tsx` | selectつきフォームのパターン |
| `src/app/products/page.tsx` | useReducer + 削除パターン |
| `src/app/facilities/[id]/edit/page.tsx` | 編集ページのパターン |
| `src/lib/facilities/repository.ts` | repositoryのパターン |
| `supabase/migrations/20260618063046_recreate_schema.sql` | マイグレーション記法の参考 |

---

## 検証方法

1. `npm test` — 全テスト緑
2. `npm run lint` — エラーなし
3. dev server 起動
4. `/categories` でカテゴリのCRUD動作確認
5. 使用中カテゴリ削除 → エラーメッセージ確認
6. `/distributor-products` で一覧・新規・編集・削除の動作確認
7. 「その他」ページからカテゴリ管理へのリンク確認
8. ナビ「販売店商品」リンク確認
