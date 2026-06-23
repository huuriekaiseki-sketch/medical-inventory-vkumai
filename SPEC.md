# SPEC: hospital_prices への粗利・仕入れ掛け率・納入掛け率の追加

---

## Part 1 — 仕様（人間レビュー用）

### 何ができるようになるか

病院価格一覧画面に、以下の3つの指標が表示されるようになります。

| 指標 | 定義 |
|------|------|
| **粗利** | 納入価格 − 仕切値（円） |
| **仕入れ掛け率** | 仕切値 ÷ 償還価格（%表示） |
| **納入掛け率** | 納入価格 ÷ 償還価格（%表示） |

> **注意**: 償還価格（reimbursement_price）が未設定の場合、掛け率は「—」表示とします。

---

### 画面イメージ

**病院価格一覧（HospitalPriceList）**

| 施設名 | 商品名 | 仕切値 | 納入価格 | **粗利** | **仕入れ掛け率** | **納入掛け率** | 操作 |
|--------|--------|--------|---------|---------|--------------|--------------|------|
| 〇〇病院 | 製品A | ¥1,000 | ¥1,200 | **¥200** | **80.0%** | **96.0%** | 編集 削除 |
| △△クリニック | 製品B | ¥500 | ¥600 | **¥100** | — | — | 編集 削除 |

📸 一覧画面に粗利・仕入れ掛け率・納入掛け率の列が表示されていること

---

### 操作の流れ

1. 病院価格一覧ページ（`/hospital-prices`）にアクセスする
2. テーブルに「粗利」「仕入れ掛け率」「納入掛け率」列が表示される
3. 粗利 = 納入価格 − 仕切値（常に表示）
4. 掛け率 = 償還価格が設定されている場合のみ %表示、未設定は「—」

---

### 受け入れ条件（チェックリスト）

- [ ] 病院価格一覧に「粗利」列が追加され、`deliveryPrice - purchasePrice` の値が円表示される
- [ ] 病院価格一覧に「仕入れ掛け率」列が追加され、`purchasePrice / reimbursementPrice × 100` が % 表示される
- [ ] 病院価格一覧に「納入掛け率」列が追加され、`deliveryPrice / reimbursementPrice × 100` が % 表示される
- [ ] reimbursementPrice が null または 0 の場合、掛け率は「—」表示
- [ ] 掛け率は小数点1桁（例: 80.0%）
- [ ] 既存テスト（77件）がすべて通過する
- [ ] 新規テストが追加される（掛け率の計算ロジック・null/0ガード）

---

## Part 2 — 実装計画（AI用・レビュー不要）

### 実装方針

**アプリケーション層での計算**（DBスキーマ変更なし）を採用する。

理由:
- 粗利・仕入れ掛け率・納入掛け率はすべて既存フィールドから導出可能
- reimbursement_price は JOIN で取得済みの値（`listHospitalPrices` に追加）
- トリガーや migration を追加するより安全・シンプル

---

### 実装セット一覧（依存順）

#### Wave 1（並列実装可）

| セット | 概要 | 触るファイル |
|--------|------|------------|
| **Set A** | repository に reimbursementPrice を追加 | `src/lib/hospital-prices/repository.ts` |
| **Set B** | HospitalPrice 型に reimbursementPrice フィールドを追加 | `src/types/hospitalPrice.ts` |

#### Wave 2（Wave 1 完了後）

| セット | 概要 | 触るファイル |
|--------|------|------------|
| **Set C** | HospitalPriceList に3列を追加 + 計算ロジック | `src/components/hospitalPrices/HospitalPriceList.tsx` + `src/components/hospitalPrices/HospitalPriceList.test.tsx` |

#### 統合ゲート

- `src/app/hospital-prices/page.tsx` の型整合確認（型が変わるので Props 確認）
- 全テスト + lint 実行

---

### 各セットの詳細

#### Set A: repository.ts

- `listHospitalPrices()` の SELECT クエリに `distributor_products(reimbursement_price)` を JOIN して取得
- 現在の Supabase クエリ: `supabase.from('hospital_prices').select(...)` を拡張
- 戻り値のマッピングに `reimbursementPrice: row.distributor_products?.reimbursement_price ?? null` を追加
- テスト観点:
  - reimbursementPrice が正しく返る
  - distributor_products が null の場合に null が返る

#### Set B: hospitalPrice.ts

- `HospitalPrice` 型に `reimbursementPrice: number | null` を追加

#### Set C: HospitalPriceList.tsx

- テーブルヘッダーに「粗利」「仕入れ掛け率」「納入掛け率」を追加
- 計算ロジック（純粋関数として定義）:
  - grossProfit = deliveryPrice - purchasePrice
  - purchaseRate = reimbursementPrice > 0 ? (purchasePrice / reimbursementPrice * 100).toFixed(1) + '%' : '—'
  - deliveryRate = reimbursementPrice > 0 ? (deliveryPrice / reimbursementPrice * 100).toFixed(1) + '%' : '—'
- テスト観点:
  - 粗利が正しく計算・表示される
  - reimbursementPrice が有効な場合に掛け率が表示される
  - reimbursementPrice が null の場合に「—」が表示される
  - reimbursementPrice が 0 の場合に「—」が表示される（ゼロ除算ガード）

---

### 型・データアクセス層の方針

- DBスキーマ変更なし（migration 不要）
- Supabase JOIN: `select('*, distributor_products(reimbursement_price)')` を使用
- 計算はすべてフロントエンド（TypeScript）で実施
- `formatPrice` 関数（既存）を粗利表示に流用

---

### 並列グループ宣言まとめ

```
Wave 1（同時実装可）:
  Set A → src/lib/hospital-prices/repository.ts のみ
  Set B → src/types/hospitalPrice.ts のみ

Wave 2（Wave 1 後）:
  Set C → src/components/hospitalPrices/HospitalPriceList.tsx + .test.tsx

統合ゲート（逐次）:
  親が src/app/hospital-prices/page.tsx の型確認
  npm test + npm run lint
```
