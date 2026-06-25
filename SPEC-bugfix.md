# 既存バグ・DB問題 修正仕様書

---

## Part 1 — 仕様（人間レビュー用）

### 概要
Phase 1 調査で発見された 214 件の問題を修正する。セキュリティ・データ安全性に関わる Critical/High 問題を優先的に解消する。

---

### 1. セキュリティ修正（Critical）

**現状の問題**
- 誰でも（ログインなしで）どの病院のデータにもアクセス・書き換えができてしまう
- データベースレベルのアクセス制御（RLS）が price_histories 以外に設定されていない
- API エンドポイントに認証チェックが存在しない

**修正後にできること**
- 認証済みユーザーのみ API を利用できる
- 各施設のスタッフは自施設のデータのみ参照・操作できる（他施設のデータは見えない）
- データベースレベルでアクセス制御されるため、API を迂回してもデータを取得できない

**受け入れ条件**
- [ ] 未認証リクエストはすべて 401 を返す
- [ ] 施設 A のデータを施設 B のユーザーが取得できない
- [ ] RLS が全テーブル（orders 系含む）に有効化されている
- [ ] SECURITY DEFINER 関数が最小権限で動作している

📸 未認証で API アクセスした場合に 401 が返ることを確認

---

### 2. DB 設計バグ修正（High）

**現状の問題**
- カテゴリを削除しようとすると、関連する流通製品があるときエラーになる（ON DELETE 未設定）
- 注文データの JAN コードが製品マスタと紐付いていない（重複・不整合リスク）
- 注文・消耗品テーブルへのクエリが遅い（インデックス欠落）

**修正後にできること**
- カテゴリ削除時に関連製品が自動的に連動する（CASCADE）
- JAN コードが製品マスタと一致している状態が保証される
- 施設・ステータスでの絞り込みが高速に動作する

**受け入れ条件**
- [ ] カテゴリ削除が正常に動作する
- [ ] `case_order_items` / `loan_order_items` / `loan_return_items` の jan が products.jan を参照している
- [ ] facility_id + status / facility_id + created_at の複合インデックスが存在する

---

### 3. エラーハンドリング統一（High）

**現状の問題**
- API エラー時のレスポンス形式がバラバラ（開発者が原因特定しにくい）
- 一部の API でエラーが握りつぶされ、500 エラーとして返る
- 削除後のリロードが完了前に走る race condition がある（`handleDelete` に await なし）

**修正後にできること**
- エラー発生時は統一フォーマット `{ error: "..." }` で返る
- 削除操作が完了してからリストが更新される
- エラーの種類が判別できる

**受け入れ条件**
- [ ] 全 API エンドポイントのエラーレスポンスが統一形式
- [ ] `handleDelete()` が await で完了を待つ
- [ ] リポジトリ層の例外が適切にキャッチされ、意味のあるエラーメッセージを返す

📸 商品削除後にリストが正しく更新される画面

---

### 4. 型安全性修正（High）

**現状の問題**
- DB の値を `as string` / `as number` で強制キャストしている（null が来ると実行時エラー）
- `Record<string, unknown>` への無条件キャストが 23 箇所存在

**修正後にできること**
- DB から null が返ってきても実行時エラーにならない
- TypeScript のコンパイル時に型の問題を検出できる

**受け入れ条件**
- [ ] mapper 関数に null/undefined チェックが追加されている
- [ ] `as string` / `as number` の無条件キャストが型ガードに置き換えられている

---

### 5. UI・フォームバグ修正（Medium）

**現状の問題**
- 注文フォームで空の品名・数量のまま送信できてしまう
- 複数の一覧画面でホバー時のスタイルが React の再レンダリングで消える

**修正後にできること**
- 必須項目が空のまま注文送信しようとするとバリデーションエラーが表示される
- ホバー時のスタイルが再レンダリング後も維持される

**受け入れ条件**
- [ ] CaseOrderModal / LoanOrderModal / ConsumableOrderModal で空送信ができない
- [ ] ProductList / CategoryList / DistributorProductList のホバースタイルが正常動作

📸 空フォームで送信ボタンを押したときのバリデーションエラー表示

---

## Part 2 — 実装計画（AI 用・レビュー不要）

### 並列グループ宣言

```
Wave 1（同時実装可）:
  Group A: DB マイグレーション修正
  Group B: リポジトリ層 型安全性修正
  Group C: UI・フォームバグ修正

Wave 2（Wave 1 完了後）:
  Group D: API エラーハンドリング統一

統合ゲート:
  - RLS 有効化マイグレーション（全テーブル）
  - API 認証ミドルウェア追加（全エンドポイントに影響）
  - npm test + npm run lint で緑確認
```

---

### Group A — DB マイグレーション修正

**触るファイル（Wave 1 独立）:**
- `supabase/migrations/20260626000000_fix_fk_and_indexes.sql`（新規）

**実装内容:**
1. `distributor_products.category_id` FK に `ON DELETE CASCADE` 追加
2. `case_order_items.jan` / `loan_order_items.jan` / `loan_return_items.jan` に `products(jan)` FK 追加
3. 複合インデックス追加:
   - `case_orders(facility_id, status)` / `(facility_id, created_at)`
   - `consumable_orders(facility_id, status)`
   - `loan_orders(facility_id, status)`
   - `loan_returns(facility_id, status)`
4. `case_order_items` / `loan_order_items` / `loan_return_items` に `updated_at` カラム追加

**テスト観点:**
- マイグレーションが冪等に実行できる
- カテゴリ削除時に関連 distributor_products が CASCADE される
- インデックスが存在する

---

### Group B — リポジトリ層 型安全性修正

**触るファイル（Wave 1 独立）:**
- `src/lib/products/repository.ts`
- `src/lib/facilities/repository.ts`
- `src/lib/consumables/repository.ts`
- `src/lib/categories/repository.ts`
- `src/lib/distributor-products/repository.ts`
- `src/lib/hospital-prices/repository.ts`
- `src/lib/case-orders/repository.ts`
- `src/lib/consumable-orders/repository.ts`
- `src/lib/loan-orders/repository.ts`
- `src/lib/loan-returns/repository.ts`
- `src/lib/price-histories/repository.ts`

**実装内容:**
1. 各 `mapX()` の `as string` / `as number` を null チェック付きに変更
   ```typescript
   // Before: row.name as string
   // After:  typeof row.name === 'string' ? row.name : ''
   ```
2. `Record<string, unknown>` キャストを明示的インタフェースに置き換え
3. `select('*')` を必要カラムのみに変更
   ⚠️ **並列制約**: Group A が `case_order_items` / `loan_order_items` / `loan_return_items` に `updated_at` を追加するが、Group B 実装時点では未適用。これらテーブルの select 列挙に `updated_at` を含めないこと（統合ゲートで追加）
4. `Number()` キャストに NaN ガード追加: `Number(row.val) || 0`

**テスト観点:**
- `npm run build` で型エラーなし
- mapper に null を渡しても実行時エラーにならない

---

### Group C — UI・フォームバグ修正

**触るファイル（Wave 1 独立）:**
- `src/components/orders/CaseOrderModal.tsx`
- `src/components/orders/LoanOrderModal.tsx`
- `src/components/orders/ConsumableOrderModal.tsx`
- `src/components/orders/ItemRowInput.tsx`
- `src/components/products/ProductList.tsx`
- `src/components/categories/CategoryList.tsx`
- `src/components/distributor-products/DistributorProductList.tsx`
- `src/app/products/page.tsx`

**実装内容:**
1. 各 OrderModal: input に `required` / 送信前に空チェック追加
2. `ItemRowInput`: `quantity` の NaN チェック
3. `ProductList` / `CategoryList` / `DistributorProductList`: `onMouseEnter/Leave` の直接スタイル操作を `useState` + className に変更
4. `products/page.tsx`: `handleDelete()` に `await` 追加

**テスト観点:**
- 空フォーム送信がブロックされる
- ホバースタイルが再レンダリング後も維持される
- `handleDelete()` 完了後にリストが更新される

---

### Group D — API エラーハンドリング統一（Wave 2）

**触るファイル（Wave 2）:**
- `src/lib/api-error.ts`（新規）
- `src/app/api/products/route.ts`
- `src/app/api/facilities/route.ts`
- `src/app/api/categories/route.ts`
- `src/app/api/consumables/route.ts`
- `src/app/api/distributor-products/route.ts`
- `src/app/api/hospital-prices/route.ts`
- `src/app/api/case-orders/route.ts`
- `src/app/api/consumable-orders/route.ts`
- `src/app/api/loan-orders/route.ts`
- `src/app/api/loan-returns/route.ts`

**実装内容:**
1. `src/lib/api-error.ts` 新規作成（共通エラーユーティリティ）
2. 全 route.ts の catch ブロックを共通ユーティリティに統一
3. `consumable-orders` / `loan-orders` / `loan-returns` に try-catch 追加
4. input の `||` チェックを `=== undefined || === null` に変更
5. レスポンスキーを `{ data: [...] }` / `{ data: {...} }` に統一

**テスト観点:**
- 全エンドポイントが `{ error: string }` 形式でエラーを返す
- `quantity: 0` が有効データとして処理される

---

### 統合ゲート — セキュリティ（RLS + API 認証）

**触るファイル（integrator 担当）:**
- `supabase/migrations/20260626001000_enable_rls.sql`（新規）
- `src/middleware.ts`（新規または更新）

**実装内容:**
1. 全テーブルに `ENABLE ROW LEVEL SECURITY`
2. 認証ユーザーのみアクセス可能な最小ポリシー追加
3. `SECURITY DEFINER` 関数に `SET search_path = public` 追加
4. `src/middleware.ts` で `/api/*` に対してセッション確認 → 未認証 401

**テスト観点:**
- `npm test` 全テストグリーン
- `npm run lint` エラーなし
- 未認証リクエスト → 401
- RLS 有効化後も既存データが正常に取得できる

---

### 実装順序まとめ

```
Step 1: Wave 1 並列実装
  ├── Group A (DB migration)
  ├── Group B (repository 型安全性)
  └── Group C (UI フォームバグ)

Step 2: Wave 2
  └── Group D (API エラーハンドリング統一)

Step 3: 統合ゲート
  ├── RLS 有効化マイグレーション
  ├── middleware.ts 認証チェック
  ├── npm test + npm run lint
  └── 緑確認後、停止②へ
```
