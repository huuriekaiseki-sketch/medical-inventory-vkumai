# 施設管理 & 施設別価格管理 UI 実装仕様

---

## Part 1 — 仕様（★人間がレビューする部分）

### 何ができるようになるか

現在、施設（病院・クリニックなど）の情報や、施設ごとの商品価格はデータベースに保存できる状態だが、画面から操作する手段がない。

今回の実装で以下が可能になる：

1. **施設の登録・一覧表示・編集・削除**
   - 施設名を入力して登録できる
   - 登録済みの施設を一覧で確認できる
   - 施設名を変更できる
   - 不要な施設を削除できる

2. **施設別価格の登録・一覧表示・編集・削除**
   - 施設と代理店商品の組み合わせに対して「仕切値（購入価格）」と「納品価格」を登録できる
   - 登録済みの価格情報を一覧で確認できる（施設名・商品名も表示）
   - 価格を変更できる
   - 不要な価格情報を削除できる

---

### 画面イメージ / 操作の流れ

#### A. 施設管理

```
ヘッダー: [Medical Inventory]  [製品マスタ] [施設管理] [施設別価格]

施設管理
────────────────────────────────────────
  [+ 新規施設を登録]

  施設名              登録日         操作
  ─────────────────────────────────────
  東京大学病院        2026-06-19    [編集] [削除]
  慶應義塾大学病院    2026-06-19    [編集] [削除]
  ─────────────────────────────────────
                                       📸
```

**新規登録 / 編集フォーム：**
```
施設名
[ テキスト入力欄                    ]

[保存]  [キャンセル]
```

**操作の流れ：**
1. 一覧ページの「+ 新規施設を登録」ボタンを押す
2. 施設名を入力して「保存」
3. 一覧に戻り、登録した施設が表示される 📸
4. 「編集」ボタンで名前を変更できる 📸
5. 「削除」ボタンで即時削除できる

---

#### B. 施設別価格管理

```
施設別価格管理
────────────────────────────────────────────────────────────────────
  [+ 新規価格を登録]

  施設          商品名         仕切値（円）  納品価格（円）  粗利（円）  操作
  ──────────────────────────────────────────────────────────────────
  東京大学病院  ○○カテーテル      8,000        10,000      2,000    [編集] [削除]
  慶應大学病院  △△ステント       15,000        18,000      3,000    [編集] [削除]
  ──────────────────────────────────────────────────────────────────
                                                                         📸
```

> 粗利 = 納品価格 − 仕切値（表示のみ、保存しない）

**新規登録 / 編集フォーム：**
```
施設
[ セレクトボックス（施設一覧から選択）  ▼ ]

代理店商品
[ セレクトボックス（商品名一覧から選択）▼ ]

仕切値（円）
[ 数値入力 ]

納品価格（円）
[ 数値入力 ]

[保存]  [キャンセル]
```

**操作の流れ：**
1. 一覧ページの「+ 新規価格を登録」ボタンを押す
2. 施設・代理店商品をセレクトボックスで選択
3. 仕切値・納品価格を入力して「保存」
4. 一覧に戻り、登録した価格が表示される 📸
5. 「編集」ボタンで価格を変更できる 📸
6. 同じ施設・商品の組み合わせを重複登録しようとするとエラーメッセージが表示される

---

### 受け入れ条件チェックリスト

#### 施設管理

- [ ] 施設一覧が表示される（`/facilities`）
- [ ] 施設の新規登録ができる（`/facilities/new`）
- [ ] 施設名が重複するとエラーメッセージが表示される
- [ ] 施設の編集ができる（`/facilities/[id]/edit`）
- [ ] 施設の削除ができる（即時削除）
- [ ] ナビゲーションに「施設管理」リンクが追加される

#### 施設別価格管理

- [ ] 施設別価格一覧が表示される（`/hospital-prices`）
- [ ] 一覧に施設名・商品名・仕切値・納品価格・粗利が表示される
- [ ] 新規価格を登録できる（`/hospital-prices/new`）
- [ ] セレクトボックスで施設・代理店商品を選択できる
- [ ] 施設が0件のとき「施設が登録されていません。先に施設を登録してください」＋施設管理へのリンクを表示する
- [ ] 仕切値・納品価格は数値のみ入力可能
- [ ] 同一施設 × 同一商品の重複登録でエラーメッセージが表示される
- [ ] 価格の編集ができる（`/hospital-prices/[id]/edit`）
- [ ] 価格の削除ができる
- [ ] ナビゲーションに「施設別価格」リンクが追加される

---

---

## Part 2 — 実装計画（AI用・レビュー不要）

### スタック・方針

- Next.js App Router（既存パターンに合わせる）
- Tailwind CSS v4（shadcn 未使用）
- API: 既存エンドポイントをそのまま使用（追加なし）
- 非制御コンポーネント（FormData API）・`useState` + `useEffect` でデータ取得
- 粗利は `delivery_price - purchase_price` をクライアント側で計算（DB保存なし）

---

### 実装セット一覧（依存順）

#### Wave 1（同時実装可 — 互いに別ファイル）

**セット A: 施設管理 UI**

触るファイル：
- `src/components/facilities/FacilityList.tsx` (新規)
- `src/components/facilities/FacilityForm.tsx` (新規)
- `src/app/facilities/page.tsx` (新規)
- `src/app/facilities/new/page.tsx` (新規)
- `src/app/facilities/[id]/edit/page.tsx` (新規)

テスト観点：
- `FacilityList`: props で渡した施設が表示される / onEdit・onDelete が呼ばれる
- `FacilityForm`: 送信時に正しい値が onSubmit に渡る / 必須バリデーション

実装詳細：
- `ProductList` / `ProductForm` のパターンをそのまま踏襲
- 一覧ページ: `useState<Facility[]>` + `useEffect(fetch('/api/facilities'))` + `useReducer` でリフレッシュ
- 削除: 即時削除（confirm なし）
- エラー表示: API が 409 を返したとき `<p className="text-red-600">` で表示

**セット B: 施設別価格管理 UI**

触るファイル：
- `src/components/hospitalPrices/HospitalPriceList.tsx` (新規)
- `src/components/hospitalPrices/HospitalPriceForm.tsx` (新規)
- `src/app/hospital-prices/page.tsx` (新規)
- `src/app/hospital-prices/new/page.tsx` (新規)
- `src/app/hospital-prices/[id]/edit/page.tsx` (新規)

テスト観点：
- `HospitalPriceList`: 粗利が正しく計算されて表示される / 施設名・商品名が表示される
- `HospitalPriceForm`: セレクトボックスの初期値が正しい / 送信時に数値型で渡る
- 重複エラー（409）が表示される

実装詳細：
- フォームページで `useEffect` を2つ使用: `GET /api/facilities` と `GET /api/distributor-products` を並列フェッチしてセレクトボックスを構築
- 粗利: `deliveryPrice - purchasePrice` を一覧コンポーネント内で計算・表示
- 数値入力: `type="number"` + `step="1"` / 送信時 `Number(formData.get(...))` で変換
- エラー表示: 409（重複）と 404（FK違反）で別メッセージを出し分ける

---

#### Wave 2（統合ゲート — 共有ファイルを触る）

**セット C: ナビゲーション更新**

触るファイル：
- `src/app/layout.tsx` (既存・変更)

実装詳細：
- ヘッダーに `/facilities`（施設管理）と `/hospital-prices`（施設別価格）リンクを追加
- 既存の `/products`（製品マスタ）リンクの隣に並べる
- スタイル: 既存リンクと同じ `text-sm text-slate-300 hover:text-white`

---

### 並列グループ宣言

```
Wave 1（同時起動）
  ├── セット A: 施設管理 UI
  └── セット B: 施設別価格管理 UI

    ↓ 両方完了後

Wave 2（統合ゲート・逐次）
  └── セット C: ナビゲーション更新 + 全テスト + lint
```

Wave 1 のセット A と B は共有ファイルを触らないため、同一 worktree での並列実装が可能。
Wave 2 は `layout.tsx` という共有ファイルを触るため、親（または 1 体の implementer）が単独で実施する。

---

### ファイル依存マップ

```
既存（変更なし）
  src/lib/facilities/repository.ts
  src/lib/hospital-prices/repository.ts
  src/lib/distributor-products/repository.ts
  src/types/facility.ts
  src/types/hospitalPrice.ts
  src/types/distributorProduct.ts
  src/app/api/facilities/*
  src/app/api/hospital-prices/*
  src/app/api/distributor-products/*

Wave 1 新規作成（セット A）
  src/components/facilities/FacilityList.tsx
  src/components/facilities/FacilityForm.tsx
  src/app/facilities/page.tsx
  src/app/facilities/new/page.tsx
  src/app/facilities/[id]/edit/page.tsx

Wave 1 新規作成（セット B）
  src/components/hospitalPrices/HospitalPriceList.tsx
  src/components/hospitalPrices/HospitalPriceForm.tsx
  src/app/hospital-prices/page.tsx
  src/app/hospital-prices/new/page.tsx
  src/app/hospital-prices/[id]/edit/page.tsx

Wave 2 更新（統合ゲート）
  src/app/layout.tsx
```
