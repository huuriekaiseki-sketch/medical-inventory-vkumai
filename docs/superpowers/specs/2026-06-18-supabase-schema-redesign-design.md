# Supabase スキーマ再設計 + リポジトリ移行

Date: 2026-06-18

## 概要

既存のインメモリ `products` テーブル（単一テーブル）を廃止し、医療機器在庫管理に適した4テーブル構成に再設計する。同時に Next.js のデータ層を Supabase（PostgreSQL）に移行する。

---

## データモデル

### products（製品マスタ）

製品の識別子のみを保持する親テーブル。

| カラム | 型 | 制約 |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| jan | text | NOT NULL, UNIQUE |
| ref | text | NOT NULL, UNIQUE |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

### distributor_products（代理店テーブル）

products を親とする子テーブル。代理店が扱う商品の詳細情報。

| カラム | 型 | 制約 |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| product_id | uuid | FK → products.id ON DELETE CASCADE |
| maker | text | NOT NULL（メーカー） |
| supplier | text | NOT NULL（仕入れ先） |
| name | text | NOT NULL（商品名） |
| reimbursement_price | numeric | NULL可（償還価格） |
| quantity | integer | NOT NULL, default 1（数量） |
| category | text | NOT NULL（商品区分） |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

### facilities（施設マスタ）

取引先病院・施設のマスタ。

| カラム | 型 | 制約 |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| name | text | NOT NULL, UNIQUE（例: A病院, B病院） |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

### hospital_prices（病院別価格）

「代理店商品 × 施設」の組み合わせごとの価格。粗利は delivery_price - purchase_price でアプリ側計算。

| カラム | 型 | 制約 |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| distributor_product_id | uuid | FK → distributor_products.id ON DELETE CASCADE |
| facility_id | uuid | FK → facilities.id ON DELETE CASCADE |
| purchase_price | numeric | NOT NULL（仕入れ価格） |
| delivery_price | numeric | NOT NULL（納入価格） |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

**ユニーク制約**: (distributor_product_id, facility_id) の組み合わせは重複不可。

---

## リレーション図

```
products
  └─< distributor_products
                └─< hospital_prices >─ facilities
```

---

## マイグレーション方針

1. 既存の `20260618055941_create_products_table.sql` を廃止（DROP TABLE products）
2. 新規マイグレーションで4テーブルを作成
3. 全テーブルに `updated_at` 自動更新トリガーを設定
4. RLS は automatic RLS が有効なため、service role キーでサーバーサイドからアクセス（ポリシー設定は別フェーズ）

---

## アプリケーション層の変更

### 削除するファイル

- `src/lib/products/repository.ts`（インメモリ実装）
- `src/__tests__/repository.test.ts`（インメモリ前提のテスト）
- `src/types/product.ts`（旧スキーマ型定義）

### 新規作成するファイル

- `src/lib/supabase/server.ts` — service role クライアント
- `src/types/` — products, distributorProducts, facilities, hospitalPrices の型定義
- `src/lib/products/repository.ts` — Supabase 版（同名で置き換え）
- `src/lib/distributor-products/repository.ts`
- `src/lib/facilities/repository.ts`
- `src/lib/hospital-prices/repository.ts`

### API routes

既存の `/api/products` を新スキーマに合わせて更新。distributor_products / facilities / hospital_prices のエンドポイントを追加。

### 環境変数

`.env.local` に追加：
```
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
```

---

## スコープ外（後回し）

- 代理店テーブルの「取引施設」カラム（代理店×施設のリレーション）
- RLS ポリシーの詳細設定
- フロントエンドのUI全面刷新
