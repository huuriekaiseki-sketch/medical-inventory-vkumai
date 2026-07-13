# 機能仕様書 — 在庫マスタのカラム追加

> ステータス: **実装完了（Phase 3-5実施済み・停止②構造化レビュー待ち）**
> 作成日: 2026-07-10
> 承認日: 2026-07-13（name必須・maker自由入力、いずれも提案通りで承認）

---

## Part 1 — 仕様（★人間がレビューする部分）

### 何ができるようになるか

現在のデバイスマスタ（製品一覧）には「JANコード」と「REFコード」しか登録できない。
今回の変更で **製品名** と **メーカー名** を追加登録できるようになる。

- 在庫一覧画面で製品名・メーカー名が列として表示される
- 新規登録・編集フォームで製品名・メーカー名を入力できる
- 症例発注・短貸発注などで製品を参照する際に名称が表示され、コードだけでは区別できなかった製品を識別しやすくなる

### 追加カラム定義

| カラム | 表示名 | 型 | 必須 | 補足 |
|--------|--------|-----|------|------|
| `name` | 製品名 | TEXT | ✅ 必須 | 例：「カテーテルAB型」 |
| `maker` | メーカー名 | TEXT | 任意 | 例：「テルモ」「バイエル」 |

> **判断が必要な点（レビュー時に確認）**
>
> 1. `name` は必須にするか、任意（既存レコードへの影響を避ける）にするか
>    - 必須にする場合 → 既存レコードを移行する際にデフォルト値が必要（例: `''` or `jan` の値を使う）
>    - 任意にする場合 → NULL 許可、フォームは入力推奨表示にとどめる
> 2. `maker` は自由入力か、マスタ（別テーブル）か
>    - 今回のスコープは自由テキスト入力とし、マスタ化は別タスクとする方針でよいか

### 操作の流れ

#### A. 新規製品登録

1. サイドバーから「デバイス」を開く
2. 「+ 新規登録」ボタンをクリック
3. 以下フォームが表示される:
   - JAN コード（既存・必須）
   - REF コード（既存・必須）
   - **製品名（新規追加・必須）**
   - **メーカー名（新規追加・任意）**
4. 入力して「登録」をクリック
5. 一覧画面に戻り、登録した製品が先頭に表示される 📸

#### B. 製品編集

1. 一覧の「編集」ボタンをクリック
2. 既存の製品名・メーカー名が初期値としてセットされている 📸
3. 変更して「更新」をクリック
4. 一覧に反映される

#### C. 製品一覧の表示

- 一覧テーブルに「製品名」「メーカー名」列が追加される 📸
- 既存レコード（名称未設定）は空欄表示または「—」で表示

---

### 受け入れ条件チェックリスト

#### 登録・更新

- [x] 製品名が空欄のまま「登録」するとバリデーションエラーが表示される（空欄・空白のみ両方をAPI/E2Eで検証済み）
- [x] JAN 重複・REF 重複のエラーは従来通り表示される（既存テスト継続green）
- [x] メーカー名が未入力でも登録できる
- [x] 製品名・メーカー名に日本語・記号（スラッシュ、スペース等）が入力できる（mapper.test.tsに追加検証）

#### 一覧・表示

- [x] 一覧テーブルに「製品名」「メーカー名」列が表示される
- [x] メーカー名が未設定の製品は「—」（または空欄）で表示される
- [x] 既存レコード（移行前データ）が一覧で正常に表示される（mapProductのundefinedフォールバックで検証）

#### 非機能

- [x] マイグレーション適用後、既存データが壊れていない（DEFAULT '' または NULL 許可で対処、`supabase db push`適用済み）
- [x] **（訂正）products の書き込み（登録・編集）は管理者（admin）のみ可能。施設スタッフは不可** — `20260629000001_fix_master_rls.sql`（SET F、docs/agents/decisions.md「なぜマスタデータの書き込みをadmin限定にしたか」参照）による意図的な既存RLS制約であり、今回の変更で新たに導入したものではない。当初この項目は「管理者・施設スタッフ双方が登録・編集できる」という汎用テンプレート文言のまま書かれていたが、2026-07-13にE2E CIの実失敗（`new row violates row-level security policy`）で誤りが発覚し訂正した。E2Eテストはadmin権限のユーザーで実行する

---

## Part 2 — 実装計画（AI 用・技術詳細・レビュー不要）

### 前提

- `name` は NOT NULL、既存レコードには `DEFAULT ''` を付与して移行
- `maker` は NULL 許可（任意フィールド）
- RLS ポリシーは変更不要（`products` テーブルに施設スコープはない）
- `PRODUCT_COLUMNS` 定数・`ProductRow` 型・`mapProduct` を同時更新
- RISK 判定: `supabase/migrations/` 変更を含むため **RISK=はい（M/L レーン必須）**

---

### 実装セット一覧（依存順）

#### Wave 1（並列可）— DB と TypeScript 型定義

**Set A: DB マイグレーション**

触るファイル:
- `supabase/migrations/YYYYMMDDHHMMSS_add_products_name_maker.sql`（新規作成）

内容（骨格）:
```sql
ALTER TABLE products
  ADD COLUMN name  TEXT NOT NULL DEFAULT '',
  ADD COLUMN maker TEXT;
```

テスト観点:
- `supabase db reset` でエラーなく適用される
- 既存シードデータが壊れない

---

**Set B: TypeScript 型定義更新**

触るファイル:
- `src/types/product.ts`

変更内容:
```ts
export type Product = {
  id: string
  jan: string
  ref: string
  name: string          // 追加
  maker: string | null  // 追加
  createdAt: string
  updatedAt: string
}

export type ProductInput = {
  jan: string
  ref: string
  name: string          // 追加
  maker?: string | null // 追加
}
```

テスト観点: `tsc --noEmit` でコンパイルエラーなし（他レイヤー変更前は型エラーが残る点に注意）

---

#### Wave 2（Wave 1 完了後・並列可）— リポジトリ・API

**Set C: リポジトリ層更新**

触るファイル:
- `src/lib/products/repository.ts`
- `src/lib/products/__tests__/mapper.test.ts`

変更内容:
- `PRODUCT_COLUMNS` に `name, maker` を追加
- `ProductRow` に `name?: unknown; maker?: unknown` を追加
- `mapProduct` に `name: asString(row.name)` と `maker: row.maker != null ? asString(row.maker) : null` を追加
  - maker は `asString` で `''` に丸めず `null` を保持する（任意フィールドのため）
- `createProduct` の `insert` ペイロードに `name: input.name, maker: input.maker ?? null` を追加
- `updateProduct` の `update` ペイロードに同上を追加

テスト観点（mapper.test.ts 更新）:
- `mapProduct` に `name`/`maker` が正常に変換されること
- `maker: null` → `null` で返ること（`asString` で `''` にしない）
- `name: undefined` → `''` にフォールバックすること

---

**Set D: API Route 更新**

触るファイル:
- `src/app/api/products/route.ts`
- `src/app/api/products/[id]/route.ts`

変更内容:
- `route.ts` POST バリデーション: `!input.name` を追加し `'製品名は必須です'` を返す
- `[id]/route.ts` PUT バリデーション: 同上を追加

テスト観点:
- `name` なしの POST → 400 エラー、メッセージ「製品名は必須です」
- `maker` なしの POST → 201 成功（任意フィールド）

---

#### Wave 3（Wave 2 完了後・並列可）— UI 層

**Set E: フォームコンポーネント更新**

触るファイル:
- `src/components/products/ProductForm.tsx`

変更内容:
- `handleSubmit` で `name: formData.get('name') as string` と `maker: formData.get('maker') as string || null` を追加
- `<input name="name" required>` フィールドを JAN・REF の間（または後）に追加
- `<input name="maker">` フィールドを追加（任意・`required` なし）
- `defaultValues` に `name`/`maker` を反映

テスト観点:
- `name` 入力欄に `required` が付いており、空送信でブラウザネイティブバリデーションが動く
- `maker` は未入力でも `handleSubmit` が呼ばれる

---

**Set F: 一覧コンポーネント更新**

触るファイル:
- `src/components/products/ProductList.tsx`

変更内容:
- テーブルヘッダに「製品名」「メーカー名」列を追加
- `product.name` / `product.maker ?? '—'` を表示

テスト観点:
- `maker` が `null` の行が「—」表示される
- 既存の JAN / REF 列の順序が維持されている

---

**Set G: 編集ページの defaultValues 更新**

触るファイル:
- `src/app/products/[id]/edit/page.tsx`

変更内容:
- `defaultValues` を `{ jan: product.jan, ref: product.ref, name: product.name, maker: product.maker }` に拡張

テスト観点:
- 編集画面を開いたとき製品名・メーカー名が初期値として表示される

---

#### 統合ゲート（Wave 3 完了後）

**Set H: E2E テスト追加**

触るファイル:
- `e2e/products.spec.ts`（新規作成）

テストシナリオ（e2e-runner の 📸 撮影ポイントと対応）:
1. `/products` を開く → 「製品名」列が見える 📸
2. 「+ 新規登録」→ name/maker を入力して登録 → 一覧に反映 📸
3. 「編集」 → name を変更して更新 → 一覧に反映 📸
4. name を空にして「登録」 → バリデーションエラーが表示される
5. maker を空にして「登録」 → 201 成功

---

### 並列グループ宣言（波まとめ）

```
Wave 1 ──┬── Set A (migration)    supabase/migrations/XXXX_add_products_name_maker.sql
          └── Set B (TS 型)        src/types/product.ts
             ↓ 両方完了後
Wave 2 ──┬── Set C (repository)   src/lib/products/repository.ts
          │                        src/lib/products/__tests__/mapper.test.ts
          └── Set D (API Route)    src/app/api/products/route.ts
                                   src/app/api/products/[id]/route.ts
             ↓ 両方完了後
Wave 3 ──┬── Set E (ProductForm)  src/components/products/ProductForm.tsx
          ├── Set F (ProductList)  src/components/products/ProductList.tsx
          └── Set G (edit page)    src/app/products/[id]/edit/page.tsx
             ↓ 全完了後
統合 ────── Set H (E2E)           e2e/products.spec.ts（新規）
```

各 Wave 内のセットは互いに別ファイルのみを触るため完全並列可能。

---

### 調査で判明した既存の技術的負債（今回のスコープ外）

今回の実装中に触れるファイルで確認された問題だが今回は修正しない（別 issue 化を推奨）:

- `ProductForm.tsx` — `formData.get('jan') as string` の null チェックなし
- `src/app/api/products/route.ts` — `requireFacilityAccess` 未使用（products がマルチテナント非対応）
- `PRODUCT_COLUMNS` 文字列定数 — スキーマ変更時の手動更新依存
- `database.types.ts` 不在 — Supabase CLI 生成型なし、手動型定義への依存が継続
