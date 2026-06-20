# SPEC: 販売店商品（Distributor Products）管理UI

---

## Part 1 — 仕様（人間レビュー用）

### 何ができるようになるか

販売店から仕入れる商品（販売店商品）を画面から一覧表示・登録・編集・削除できるようになります。

各商品には以下の情報が登録されます：
- どの製品か（製品コードで紐付け）
- メーカー名
- 仕入先（販売店名）
- 商品名
- カテゴリ
- 償還価格（任意）
- 数量

---

### 画面イメージ / 操作の流れ

#### 1. 一覧ページ（/distributor-products）

```
販売店商品一覧
────────────────────────────────────────────────────────
[ + 新規登録 ]
────────────────────────────────────────────────────────
| 商品名        | メーカー | 仕入先  | カテゴリ | 償還価格 | 数量 | 操作       |
| ○○カテーテル  | ○○社    | ○○商事  | 消耗品   | ¥1,200  |  5  | [編集][削除]|
| △△ガーゼ     | △△社    | △△商事  | 消耗品   | —       | 10  | [編集][削除]|
────────────────────────────────────────────────────────
```
📸 一覧表示（データあり）
📸 一覧表示（データなし・空状態）

#### 2. 新規登録ページ（/distributor-products/new）

```
販売店商品を登録
──────────────────────────────
製品（Products）  [ セレクト ▼ ]
メーカー          [ テキスト   ]
仕入先            [ テキスト   ]
商品名            [ テキスト   ]
カテゴリ          [ テキスト   ]
償還価格（円）    [ 数値・任意  ]
数量              [ 数値       ]
                  [ 登録する   ]
──────────────────────────────
```
📸 フォーム表示（空）
📸 バリデーションエラー表示

#### 3. 編集ページ（/distributor-products/[id]/edit）

- 登録と同じフォームに既存値が入力済みで表示される
📸 フォーム表示（既存値入り）

---

### 受け入れ条件（チェックリスト）

**一覧**
- [ ] `/distributor-products` にアクセスすると商品一覧が表示される
- [ ] 商品がない場合は「商品が登録されていません」を表示する
- [ ] 「新規登録」ボタンで `/distributor-products/new` に遷移する
- [ ] 「編集」ボタンで `/distributor-products/[id]/edit` に遷移する
- [ ] 「削除」ボタンで確認ダイアログを表示し、OKで削除・一覧を再取得する
- [ ] API取得失敗時にエラーメッセージを表示する

**新規登録**
- [ ] 全必須項目（製品・メーカー・仕入先・商品名・カテゴリ・数量）を入力して登録できる
- [ ] 償還価格は空欄のまま登録できる（任意項目）
- [ ] 登録成功後に一覧ページへ遷移する
- [ ] APIエラー時にフォーム内にエラーメッセージを表示する

**編集**
- [ ] 既存の値がフォームに初期表示される
- [ ] 変更して保存すると一覧ページへ遷移する
- [ ] APIエラー時にフォーム内にエラーメッセージを表示する

---

## Part 2 — 実装計画（AI用・レビュー不要）

### 型・API方針

- 型: `src/types/distributorProduct.ts`（既存）— 変更なし
- API: `src/app/api/distributor-products/` 以下（既存）— 変更なし
- **レスポンスキー注意**: 一覧は `{ items }`, 単件は `{ item }`（products の `{ products }` / `{ product }` と異なる）
- フォームの製品セレクトは `GET /api/products` → `{ products: Product[] }` から取得

### 実装セット一覧

| セット | 内容 | 触るファイル |
|--------|------|------------|
| A | DistributorProductListコンポーネント | `src/components/distributor-products/DistributorProductList.tsx` |
| B | DistributorProductFormコンポーネント | `src/components/distributor-products/DistributorProductForm.tsx` |
| C | 一覧ページ | `src/app/distributor-products/page.tsx` |
| D | 新規登録ページ | `src/app/distributor-products/new/page.tsx` |
| E | 編集ページ | `src/app/distributor-products/[id]/edit/page.tsx` |
| F | ナビゲーション結線（統合ゲート） | `src/app/layout.tsx` |

### 並列グループ宣言

```
Wave 1（同時実装可 — ファイル独立）
  ├── セット A: DistributorProductList.tsx
  └── セット B: DistributorProductForm.tsx

      ↓ Wave 1 完了後

Wave 2（同時実装可 — ファイル独立）
  ├── セット C: distributor-products/page.tsx        ← セット A に依存
  ├── セット D: distributor-products/new/page.tsx    ← セット B に依存
  └── セット E: distributor-products/[id]/edit/page.tsx ← セット B に依存

      ↓ Wave 2 完了後

統合ゲート（逐次・親が担当）
  └── セット F: layout.tsx にナビゲーションリンク追加
```

### 各セットのテスト観点

**セット A（DistributorProductList）**
- データあり: 商品名・メーカー・仕入先・カテゴリ・償還価格・数量が正しく表示される
- 償還価格null: "—"（ダッシュ）表示
- 空配列: 空状態メッセージ表示
- 編集ボタンクリック: onEdit(id) が呼ばれる
- 削除ボタンクリック: onDelete(id) が呼ばれる

**セット B（DistributorProductForm）**
- products が select に表示される
- defaultValues が各フィールドに反映される
- isSubmitting 中: submitボタンがdisabled
- submitError あり: エラーメッセージ表示
- reimbursementPrice 空欄: null として渡される（0ではなくnull）
- quantity: min=1、integer のみ

**セット C（一覧ページ）**
- fetch成功: items がリストに渡される
- fetch失敗: エラーバナー表示
- 削除成功: 一覧再取得
- 削除失敗: エラーバナー表示（削除前後にリフレッシュしない）

**セット D（新規登録ページ）**
- POST成功: `/distributor-products` にリダイレクト
- POST失敗: フォーム内エラーメッセージ表示

**セット E（編集ページ）**
- GET成功: フォームに既存値が入る
- GET失敗: エラーメッセージ表示（フォーム非表示）
- PUT成功: `/distributor-products` にリダイレクト
- PUT失敗: フォーム内エラーメッセージ表示

### フォームフィールド詳細（セット B 実装参考）

| フィールド | 入力型 | 必須 | 備考 |
|-----------|--------|------|------|
| productId | select | ○ | GET /api/products から取得。`${product.jan} / ${product.ref}` で表示 |
| maker | text | ○ | |
| supplier | text | ○ | |
| name | text | ○ | |
| category | text | ○ | |
| reimbursementPrice | number | — | 空欄=null。`Number(v) || null` で変換 |
| quantity | number | ○ | min=1、step=1 |

### エラーハンドリング方針

| 状況 | 表示 |
|------|------|
| 一覧fetch失敗 | エラーバナー（FacilitiesPage パターン） |
| フォーム送信失敗 | フォーム内エラーメッセージ（FacilityForm パターン） |
| 削除失敗 | エラーバナー（ProductsPage パターン） |
| 404 | "商品が見つかりません" |
| その他API | APIレスポンスの `error` フィールドをそのまま表示 |

### スタイル方針

- 既存の企業デザイン（#072C2C / #FF5F03 / Oswald / Ubuntu Mono）に合わせる
- ProductList・FacilitiesPage のスタイルパターンを踏襲
