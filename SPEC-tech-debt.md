# SPEC: コードベース技術負債修正・品質向上

調査フェーズで発見した問題を修正し、安定性・セキュリティ・保守性を向上させます。

---

## Part 1 — 仕様（人間レビュー用）

### 何ができるようになるか（利用者目線）

現在のシステムで起きている・起きうる問題を修正します。ユーザーが体感できる変化を中心に説明します。

#### 1. エラーが画面に正しく表示されるようになる
- ネットワーク障害や操作失敗時に「エラーが発生しました」と明確に表示される
- 削除や更新が失敗しても、古いエラーメッセージがそのまま残らない
- 削除失敗時にユーザーが「すでに消えた」と勘違いしない

#### 2. 金額の入力ミスが防止される
- 金額フィールドを空白のまま送信すると「0円」として登録される問題を修正
- 空白と「0」を正しく区別する

#### 3. 発注・返却フォームが安全になる
- 複数行を追加・削除するフォームで、行が入れ替わっても内容がずれない
- 同じデータを二重送信しにくくなる

#### 4. 発注履歴が参照できるようになる
- 消耗品発注・ケース発注・貸出・返却のそれぞれの一覧を取得できるAPIが追加される（管理画面への一覧ページ実装の前提）

#### 5. マスタデータのアクセス制御が明確になる
- 商品・カテゴリ・販売店商品について、「誰でも閲覧・変更できる」のか「認証ユーザーのみ」なのかを設計仕様として明確化し、意図通りのRLSポリシーを設定する

#### 6. セキュリティヘッダーが設定される
- ブラウザに対してクリックジャッキング防止などの基本ヘッダーが送信される

---

### 受け入れ条件（チェックリスト）

#### エラーハンドリング
- [ ] 一覧ページ（施設・商品・カテゴリ）でネットワークエラー時にエラーメッセージが表示される
- [ ] 削除失敗時に「削除に失敗しました」と表示され、リストは変化しない
- [ ] 編集ページで存在しないIDにアクセスすると「見つかりません」が表示される
- [ ] ページ遷移後に古いエラーが持ち越されない

📸 施設一覧で意図的に失敗させたとき、エラーが表示されること

#### 金額入力
- [ ] 病院価格フォームで金額を空のまま送信すると「金額を入力してください」と警告される
- [ ] 償還価格（任意）が空欄のとき、0ではなくNULLとして保存される
- [ ] 0円は明示的に入力した場合のみ登録できる

📸 金額フィールドが空のまま送信ボタンを押したとき、バリデーションエラーが表示されること

#### 発注フォーム
- [ ] 明細行を削除した後、残った行のデータが正しく保持されている
- [ ] 送信ボタン押下後、処理完了まで再送信できない（ボタンがdisabledになる）

📸 明細行が2行ある状態で1行目を削除しても2行目の内容が消えないこと

#### 発注API
- [ ] `GET /api/consumable-orders` で消耗品発注一覧が取得できる
- [ ] `GET /api/case-orders` でケース発注一覧が取得できる
- [ ] `GET /api/loan-orders` で貸出発注一覧が取得できる
- [ ] `GET /api/loan-returns` で返却一覧が取得できる

#### マスタデータRLS
- [ ] 未認証ユーザーが商品・カテゴリ・販売店商品にアクセスできない（仕様を明示した上で実装）
- [ ] 認証済みユーザーは全施設の商品マスタを閲覧できる（マスタは施設横断共有の設計）
- [ ] 認証済みユーザーは商品マスタのCRUDが可能（管理者以外の書き込みを制限する場合は別途議論）

#### セキュリティ
- [ ] `X-Frame-Options: DENY` ヘッダーがレスポンスに含まれる
- [ ] `X-Content-Type-Options: nosniff` ヘッダーがレスポンスに含まれる

📸 ブラウザのDevToolsでレスポンスヘッダーにX-Frame-Optionsが表示されること

---

## Part 2 — 実装計画（AI用・レビュー不要）

### 実装セット一覧（依存順）

---

#### SET A — APIレスポンス形式の統一（依存なし）

**目的:** `{ data, data: data }` の冗長な二重キーを排除し、全エンドポイントで `{ <entity> }` 形式に統一

**触るファイル:**
- `src/app/api/products/route.ts`
- `src/app/api/facilities/route.ts`
- `src/app/api/categories/route.ts`
- `src/app/api/consumables/route.ts`
- `src/app/api/hospital-prices/route.ts`
- `src/app/api/distributor-products/route.ts`
- `src/app/api/loan-orders/route.ts`
- `src/app/api/loan-returns/route.ts`

**方針:**
- POST成功: `NextResponse.json({ <entity> }, { status: 201 })`
- GET成功: `NextResponse.json({ <entities> })`
- `data:` キーを除去（既存クライアントは `d.<entity>` で参照しているためUI側の変更不要）

**テスト観点:**
- 各ルートのJSONレスポンスに `data` キーが含まれないこと
- `status: 201` がPOST時に返ること

---

#### SET B — エラーハンドリング統一（依存なし）

**目的:** UIのfetch失敗時のcatch漏れ・エラー表示の欠落を修正

**触るファイル:**
- `src/app/products/page.tsx`
- `src/app/facilities/page.tsx`
- `src/app/categories/page.tsx`
- `src/app/distributor-products/page.tsx`
- `src/app/hospital-prices/page.tsx`
- `src/app/admin/users/page.tsx`
- `src/components/orders/ConsumableOrderModal.tsx`

**方針:**
- 各fetch後に `if (!res.ok) throw new Error(await res.text())` パターンを統一
- `useEffect` cleanup で `AbortController` を使用し、アンマウント後のsetState呼び出しを防止
- `setError` の初期化を `useEffect` 先頭に追加（ページ遷移時の古いエラー残存防止）

**テスト観点（vitest）:**
- fetchがnon-okのとき `error` stateがセットされること
- コンポーネントアンマウント後にsetStateが呼ばれないこと

---

#### SET C — 金額入力バリデーション修正（依存なし）

**目的:** 空文字→0への暗黙変換を防止し、NULL許容フィールドを正しく扱う

**触るファイル:**
- `src/components/hospitalPrices/HospitalPriceForm.tsx`
- `src/components/distributor-products/DistributorProductForm.tsx`

**方針:**
- `Number('') === 0` 問題: `rawValue === '' || rawValue === null ? null : Number(rawValue)` パターンに変更
- 必須フィールドにHTML5 `required` 属性追加
- `formData.get()` の戻り値を `string | null` として適切に型ガード

**テスト観点（vitest）:**
- 金額フィールド空欄送信時にsubmitHandlerがnullを渡すこと
- 0入力時は0として送信されること

---

#### SET D — ItemRowInputのkeyバグ修正（依存なし）

**目的:** 配列インデックスkeyによる行削除時の状態崩れを修正

**触るファイル:**
- `src/components/orders/ItemRowInput.tsx`
- `src/components/orders/CaseOrderModal.tsx`
- `src/components/orders/LoanOrderModal.tsx`

**方針:**
- 各行に `useId` または `crypto.randomUUID()` で生成したstable IDを付与
- `key={row.id}` に変更
- CaseOrderModal/LoanOrderModalの `items` stateに `id` フィールドを追加

**テスト観点（vitest）:**
- 2行追加→1行目削除後、2行目のデータが保持されること

---

#### SET E — 発注系GET APIの追加（依存なし）

**目的:** 一覧取得エンドポイントの欠落を補完

**触るファイル（新規作成）:**
- `src/app/api/case-orders/route.ts`（GETハンドラ追加）
- `src/app/api/loan-orders/route.ts`（GETハンドラ追加）
- `src/app/api/consumable-orders/route.ts`（GETハンドラ追加）
- `src/app/api/loan-returns/route.ts`（GETハンドラ追加）
- `src/lib/case-orders/repository.ts`（listCaseOrders追加）
- `src/lib/loan-orders/repository.ts`（listLoanOrders追加）
- `src/lib/consumable-orders/repository.ts`（listConsumableOrders追加）
- `src/lib/loan-returns/repository.ts`（listLoanReturns追加）

**方針:**
- クエリパラメータ: `facility_id`（必須）、`limit`（デフォルト50）、`offset`（デフォルト0）
- RLSに依存（認証済みユーザーが自施設のみ参照可能）
- `src/types/` の既存型を再利用

**テスト観点（vitest）:**
- facility_id指定時に該当施設のデータのみ返ること
- 未認証時に401が返ること

---

#### SET F — マスタデータRLSポリシーの明確化（依存なし）

**目的:** products/categories/distributor_productsのRLSを意図通りに設定

**触るファイル（新規マイグレーション）:**
- `supabase/migrations/20260629000001_fix_master_rls.sql`

**方針（設計決定）:**
- マスタデータは施設横断共有（全認証ユーザーが参照可能）
- 書き込み（INSERT/UPDATE/DELETE）はadmin（is_admin()）のみ許可
- `auth_only` FOR ALL ポリシーを削除し、SELECT用ポリシーとCUD用ポリシーに分割

```sql
-- products: 全認証ユーザー参照可、admin書き込み可
CREATE POLICY "products_select" ON products FOR SELECT TO authenticated USING (true);
CREATE POLICY "products_write" ON products FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- categories, distributor_products も同様
```

**テスト観点:**
- 非adminユーザーがproducts INSERT→403相当エラーになること
- 非adminユーザーがproducts SELECT→成功すること

---

#### SET G — セキュリティヘッダー設定（依存なし）

**目的:** 基本的なHTTPセキュリティヘッダーをNext.jsで設定

**触るファイル:**
- `next.config.ts`

**方針:**
```ts
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];
```
- `headers()` 関数で全パスに適用

**テスト観点:**
- `curl -I` でX-Frame-Optionsヘッダーが返ること

---

#### SET H — loan_returnsのトランザクション化（SET E依存）

**目的:** loan_returnsのheader+items INSERTを原子操作にする

**触るファイル:**
- `supabase/migrations/20260629000002_loan_return_atomic_rpc.sql`（RPC新規作成）
- `src/lib/loan-returns/repository.ts`（createLoanReturn → RPC呼び出しに変更）
- `src/app/api/loan-returns/route.ts`

**方針:**
- `create_loan_return_atomic(p_header jsonb, p_items jsonb)` RPCを作成
- SECURITY DEFINER + is_facility_member() チェック
- 既存のcase/loan/consumableと同パターンに統一

**テスト観点（vitest）:**
- items INSERT失敗時にheaderもロールバックされること（Supabaseモック）

---

#### SET I — 型安全性改善（SET A依存）

**目的:** enum unsafeキャストを型ガード関数に置き換え

**触るファイル:**
- `src/lib/mapping.ts`（asEnum汎用関数追加）
- `src/lib/case-orders/repository.ts`
- `src/lib/loan-orders/repository.ts`
- `src/lib/consumable-orders/repository.ts`
- `src/lib/loan-returns/repository.ts`
- `src/lib/price-histories/repository.ts`
- `src/types/admin.ts`（Facility型をfacility.tsから再エクスポートに変更）

**方針:**
```ts
// mapping.ts に追加
export function asEnum<T extends string>(
  value: unknown,
  validValues: readonly T[],
  fallback: T
): T {
  return validValues.includes(value as T) ? (value as T) : fallback;
}
```
- `Facility` 型の重複定義を解消: `admin.ts` で `export type { Facility } from './facility'`

**テスト観点（vitest）:**
- 不正なenum値が渡されたときfallbackが返ること
- 正常値が渡されたときその値が返ること

---

### 並列グループ宣言

```
Wave 1（同時実装可）:
  SET A — API応答形式統一
  SET B — UIエラーハンドリング
  SET C — 金額バリデーション
  SET D — ItemRowInputキー修正
  SET E — 発注系GET API追加
  SET F — マスタRLS明確化
  SET G — セキュリティヘッダー

※ Wave 1 は全セットが異なるファイルを触るため並列実行可能

統合ゲート（Wave 1完了後）:
  - lint/test通過確認
  - SET Aで変更したAPIレスポンス形式とSET Bのクライアント読み取りの整合確認

Wave 2（Wave 1完了後）:
  SET H — loan_returnsトランザクション化（SET E依存）
  SET I — 型安全性改善（SET A依存）
```

---

### インデックス追加（Wave 2と並行可）

**触るファイル（新規マイグレーション）:**
- `supabase/migrations/20260629000003_add_indexes.sql`

```sql
CREATE INDEX IF NOT EXISTS idx_hospital_prices_facility_id ON hospital_prices(facility_id);
CREATE INDEX IF NOT EXISTS idx_consumables_facility_id ON consumables(facility_id);
CREATE INDEX IF NOT EXISTS idx_distributor_products_category_id ON distributor_products(category_id);
CREATE INDEX IF NOT EXISTS idx_price_histories_entity_id ON price_histories(entity_id);
CREATE INDEX IF NOT EXISTS idx_user_facilities_facility_id ON user_facilities(facility_id);
```

---

### 実装しない（スコープ外）

以下は発見されたが、本仕様のスコープから除外する。別issueで管理すること。

- ページネーション実装（全件取得問題）— データ量増大後に対応
- CSP（Content-Security-Policy）— 詳細なポリシー設計が必要
- APIエラーメッセージの国際化
- confirm() の非ブロッキングUI化
