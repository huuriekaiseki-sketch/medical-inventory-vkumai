# 製品マスタ CRUD 仕様書

## Part 1 — 仕様（人間レビュー用）

### 概要
医療機器の製品マスタを管理する画面。製品の一覧表示・新規登録・編集・削除ができる。

### データ項目
| 項目 | 必須 | 説明 |
|------|------|------|
| 製品名 | ○ | 医療機器の名称 |
| 製品コード | ○ | 一意の識別コード |
| カテゴリ | ○ | 分類（例: 消耗品、機器、試薬） |
| 単位 | ○ | 個、箱、本 など |
| 単価 | - | 参考単価（円） |

### 画面・操作の流れ

#### 1. 製品一覧画面 `/products`
- テーブル形式で全製品を表示
- 各行に「編集」「削除」ボタン
- 画面上部に「新規登録」ボタン
- 📸 一覧画面（データ3件以上表示状態）

#### 2. 新規登録 `/products/new`
- フォーム画面で製品情報を入力
- 「保存」で一覧に戻る
- 必須項目が未入力なら送信不可
- 📸 フォーム入力状態 → 📸 保存後の一覧画面

#### 3. 編集 `/products/[id]/edit`
- 既存データがフォームにプリセット
- 「更新」で一覧に戻る
- 📸 編集フォーム（値がプリセットされた状態）

#### 4. 削除
- 一覧画面の削除ボタン押下 → 確認ダイアログ → 削除実行
- 📸 確認ダイアログ表示状態

### 受け入れ条件
- [ ] `/products` で製品一覧が表示される
- [ ] 「新規登録」から製品を追加でき、一覧に反映される
- [ ] 一覧から製品を選んで編集でき、変更が反映される
- [ ] 削除ボタン → 確認 → 削除され一覧から消える
- [ ] 必須項目が空のままでは保存できない
- [ ] 製品コードが重複する場合エラーになる
- [ ] 全テストがパスする
- [ ] lint がパスする

---

## Part 2 — 実装計画（AI用・レビュー不要）

### 型定義

```typescript
// src/types/product.ts
type Product = {
  id: string
  name: string
  code: string
  category: string
  unit: string
  unitPrice: number | null
  createdAt: string
  updatedAt: string
}
```

### データアクセス層の方針
- `src/lib/products/repository.ts` にリポジトリパターンで実装
- インメモリ `Map<string, Product>` で保持
- 関数シグネチャはasync（後でSupabase差し替え時に変更不要）
- `listProducts()`, `getProduct(id)`, `createProduct(input)`, `updateProduct(id, input)`, `deleteProduct(id)`

### 実装セット一覧（依存順）

#### Wave 1（並列実装可）

**Set A: 型 + リポジトリ**
- 触るファイル:
  - `src/types/product.ts`
  - `src/lib/products/repository.ts`
  - `src/__tests__/repository.test.ts`
- テスト観点: CRUD操作の正常系、重複コードエラー、存在しないID

**Set B: フォームコンポーネント**
- 触るファイル:
  - `src/components/products/ProductForm.tsx`
  - `src/__tests__/ProductForm.test.tsx`
- テスト観点: 必須バリデーション、初期値プリセット、onSubmitコールバック

**Set C: 一覧コンポーネント**
- 触るファイル:
  - `src/components/products/ProductList.tsx`
  - `src/__tests__/ProductList.test.tsx`
- テスト観点: データ表示、編集・削除ボタンのコールバック、空リスト表示

**Set D: 削除確認ダイアログ**
- 触るファイル:
  - `src/components/products/DeleteConfirmDialog.tsx`
  - `src/__tests__/DeleteConfirmDialog.test.tsx`
- テスト観点: 表示/非表示、確認・キャンセルのコールバック

#### Wave 2（Wave 1完了後）

**Set E: APIルート**
- 触るファイル:
  - `src/app/api/products/route.ts` (GET, POST)
  - `src/app/api/products/[id]/route.ts` (GET, PUT, DELETE)
- テスト観点: 統合ゲートでE2E的に確認（API単体テストは省略）
- 依存: Set A（リポジトリ）

#### Wave 3（Wave 2完了後・統合ゲート）

**Set F: ページ（結線）— 統合ゲートで実施**
- 触るファイル:
  - `src/app/products/page.tsx`（一覧ページ）
  - `src/app/products/new/page.tsx`（新規登録ページ）
  - `src/app/products/[id]/edit/page.tsx`（編集ページ）
  - `src/app/layout.tsx`（ナビゲーションリンク追加）
- 依存: Set A, B, C, D, E すべて
- ここで共有ファイル（layout.tsx）を触るため統合ゲートで実施

### 並列グループ宣言

```
Wave 1: [Set A] [Set B] [Set C] [Set D]  ← 全て別ファイル、同時実装可
Wave 2: [Set E]                           ← Set Aに依存
Wave 3: [Set F]                           ← 統合ゲート（全セット結線）
```
