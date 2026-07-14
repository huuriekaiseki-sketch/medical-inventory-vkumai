# 機能仕様書: コンパチ（互換品）ページの実体化（issue #21）

作成日: 2026-07-14
ステータス: ドラフト（人間レビュー承認済み。Adversarial Verify 35件中35件生存＋Judge Panel統合案を反映済み）

---

## 人間レビューでの決定事項（2026-07-14）

1. **施設スコープ**: 単一共有マスタで進める（決定）。互換性は「製品仕様上の客観的事実」であり施設ごとの運用判断ではないため。「施設ごとに採用可否を分けたい」という運用は、確認の結果**現時点ではあり得ない**と判断されたため、施設スコープ・採用可否フラグはいずれも今回は導入しない。
2. **CASCADE削除**: 許容で進める（決定）。他マスタ（products/categories/distributor_products）と同じ物理削除+CASCADEパターンに揃える。論理削除化は全体アーキテクチャの話として別途検討。
3. **migration タイムスタンプ**: 実装着手日に確定（レビュー時点では判断不要、ドラフトの `20260715000001` は仮置きのまま）。
4. **UPDATE（備考編集）**: RLSは `FOR ALL` のまま進める（決定）。備考の入力ミス訂正需要があり、admin限定で既に保護されているため `INSERT/DELETE` に絞る実益は薄い。
5. **ページネーション閾値**: **500件**を閾値として仕様に明記する（Set C 実装セクション参照）。初期実装はページネーションなしで進め、`product_compatibilities` の総件数が500件を超えたらページネーション導入を別issueで検討する。
6. **既存の技術的負債の別issue化**: 承認。以下2件をissue化キューに追加済み（本issueとは独立して対応）。
   - `products`/`categories`/`distributor-products`/`facilities` の PUT/DELETE に `requireAdmin()` 呼び出しが欠落
   - `src/app/login/page.tsx:110` の `<Suspense>` に `fallback` が未設定

---

## Part 1 — 仕様（人間レビュー用）

### 何ができるようになるか（利用者目線）

「コンパチ」ページ（`/compat`）で、同一カテゴリ内の複数製品（JAN単位）が互いに代替品として使用可能かどうかを登録・検索できる。例えば「縫合糸カテゴリ」で A社製品と B社製品が互換であることを管理者が登録すると、一般ユーザーも検索して確認できる。現在 `src/app/compat/page.tsx` は「Coming Soon」のプレースホルダのままであり、これを**全面的に置き換える**。

- **一般ユーザー（施設メンバー）**: カテゴリで絞り込み、互換ペアを一覧表示・検索できる
- **管理者**: 上記に加え、互換ペアの新規登録・削除ができる

### 操作の流れ

#### 検索フロー
1. `/compat` を開く
2. カテゴリドロップダウンで絞り込む（未選択時は全件表示、初期ソートは登録日時 `created_at` 降順）
3. キーワード入力欄で製品名・JAN・メーカー名を部分一致で絞り込む
4. 結果テーブルに「カテゴリ名 / 製品A（名称・JAN・メーカー）/ 製品B（名称・JAN・メーカー）/ 備考 / 登録日」が表示される

#### 登録フロー（管理者のみ表示）
1. 「互換品を追加」ボタンをクリック
2. カテゴリを選択する（未選択の間は製品A・B の選択欄は disabled、プレースホルダー「先にカテゴリを選択してください」を表示）
3. 製品Aを選択（カテゴリ内の `distributor_products` に紐づく `products` に限定。選択肢ラベルは `{name}（JAN: {jan}、メーカー: {maker ?? '不明'}）` の形式で一覧テーブルと統一表記にする）
4. 製品Bを選択（製品Aと同じ制約。製品Aで選択済みの製品は選択肢から除外し、自己参照を未然に防ぐ。送信時にも再検証する）
5. 備考（任意、最大500文字）を入力して登録
6. 送信成功後、フォームをクリアする（モーダル使用時は閉じる）。一覧は即時再取得される
7. 重複ペア（順序問わず同一組み合わせ）は登録できず、「すでに登録済みです。【製品A名】と【製品B名】は既に互換登録されています」とエラー表示する

#### 削除フロー（管理者のみ）
- 一覧の各行に「削除」ボタン → 確認ダイアログ（「【製品A名（JAN xxx / メーカーyyy）】と【製品B名（JAN zzz / メーカーwww）】の互換登録を削除しますか？」の具体的な文言）→ DELETE API
- 既に削除済み（他管理者が先に削除した等）の場合は404を受けて「すでに削除されています」を表示し、一覧を自動再取得する

---

### 受け入れ条件チェックリスト

**機能**
- [ ] 未ログイン状態でアクセスすると `/login` にリダイレクトされる
- [ ] ログイン済みで `/compat` にアクセスすると互換品一覧が表示される（Coming Soon でなくなる）
- [ ] カテゴリ未選択で全互換ペアが `created_at` 降順で表示される
- [ ] カテゴリを選択すると同カテゴリの互換ペアのみに絞り込まれる
- [ ] キーワード入力で製品A・製品Bの名称・JAN・メーカー名を部分一致（OR条件）で絞り込める
- [ ] 管理者は「互換品を追加」フォームが表示される（一般ユーザーには表示されない）
- [ ] 登録フォームはカテゴリ未選択時、製品A・B の選択が無効化されている
- [ ] 管理者が有効なペアを登録すると一覧に即時反映され、フォームがクリアされる
- [ ] 同じペア（順序問わず）を再登録しようとすると、対象製品名を含む重複エラーになる
- [ ] 自己参照（製品A = 製品B）は、製品Bの選択肢から製品Aを除外することで防止される（送信時にも400で再検証）
- [ ] 管理者が削除ボタンを押すと、削除対象の製品名・JAN・メーカーを含む確認ダイアログの後に行が消える
- [ ] 削除対象が既に存在しない場合（404）、「すでに削除されています」と表示され一覧が再取得される

**セキュリティ**
- [ ] 一般ユーザーが POST /api/compat に直接リクエストすると 403 が返る
- [ ] 一般ユーザーが DELETE /api/compat/[id] に直接リクエストすると 403 が返る
- [ ] 未認証リクエストは 401 が返る
- [ ] GET /api/compat/products も認証必須（未認証は401）。カテゴリに属さない製品情報の推測はカテゴリ内提示に限定されるため追加の施設スコープ制御は不要（本機能はテナント非分離。上記「未解決事項1」参照）

**DB**
- [ ] `product_compatibilities` テーブルが migration で作成される
- [ ] `(category_id, product_id_1, product_id_2)` に UNIQUE 制約がある
- [ ] `product_id_1 < product_id_2` の CHECK 制約で順序正規化がある（(a,b)と(b,a)の二重登録防止）
- [ ] RLS: SELECT は全認証ユーザー、CUD は `is_admin()` のみ
- [ ] migration末尾で `refresh_schema_baseline_snapshot()` を呼んでいる（issue #305要件）

**UI**
- [ ] 本ページは `useSearchParams()` を使わない設計のため `<Suspense>` ラップは不要（URL連動フィルタは今回スコープ外）
- [ ] 一覧が0件のとき、状況に応じて空状態メッセージが出し分けられる:
  - 全体0件かつ管理者:「互換品が登録されていません」＋「＋互換品を追加」への導線
  - 全体0件かつ一般ユーザー:「互換品はまだ登録されていません」
  - フィルタ結果0件（登録は存在）:「条件に一致する互換品がありません」
- [ ] 一覧初回表示・再取得中はテーブル領域にスケルトンまたはスピナーを表示する
- [ ] カテゴリ変更時、製品候補取得中は製品Select近傍にインラインスピナーを表示し、Selectを一時disabledにする
- [ ] 削除・製品候補取得・一覧再取得のいずれかでネットワークエラーが発生した場合、画面上部にエラーメッセージを表示する（既存 `products` ページと同一パターン）

---

## Part 2 — 実装計画（AI用）

### 設計方針の確定事項（Judge Panel採用: 保守的設計アプローチ、スコア78）

| 論点 | 採用 | 理由 |
|---|---|---|
| ページ構成 | 純 `'use client'` + `useReducer(refreshKey)` + `useEffect(fetch)` | Server/Client混在は本プロジェクト初の構成でrefreshKeyがServer再実行に繋がらないリスクがある。既存 `products/page.tsx` と同型にして実装差異を排除する |
| Admin認可 | `requireAuth(db)` + `resolveIsAdmin(db, user)` を直接呼ぶ | `requireAdmin()`（`src/lib/admin-auth.ts`）は内部で `createServerSupabase()` を二重生成するため使わない。`facilities` API と同型でテストモックも整合する |
| 製品候補取得 | `/api/compat/products` を新設 | 既存 `/api/products` のGET仕様変更によるクライアント影響を避け、責務を`/compat`ドメインに閉じる |
| キーワード検索 | サーバサイド `.ilike`（Supabaseパラメータバインド） | raw SQL禁止でSQLiリスクを排除。GIN/pg_trgmは初期実装では不要（マスタ件数が少ない前提。件数増大時は別issueで検討） |
| ON DELETE CASCADE | 許容 | 他マスタと同じ物理削除パターンに揃える（人間レビューで決定）。論理削除化は全体アーキ検討として別途 |
| ページネーション | 初期実装では対応せず、初期ソートのみ `created_at DESC` を明記 | 500件超過で別issue検討（人間レビューで決定した閾値） |

不採用（検討したが見送り）: **互換グループモデル**（`compat_groups` + `compat_group_members` の2テーブル方式）。N対N表現には優れるが、ペア追加時のグループ検索・マージ・孤立グループ自動削除のロジックが大幅に増え、issue #21 の要求（ペア登録・検索）に対し過剰設計と判断。将来「3製品以上の互換群」要件が出た場合の再検討候補として記録する。

---

### DB設計（テーブル定義）

```sql
-- migration: <実装日に合わせて確定>_create_product_compatibilities.sql
-- (ドラフトでは 20260715000001 を仮置き。未解決事項3を参照し実装日で確定すること)

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

-- インデックス戦略（category_id・product_id_1/2 に対するFK/絞り込み用。
-- keyword検索は products.name/jan/maker に対するJOIN後の.ilikeであり、
-- このインデックスでは加速されない。マスタ件数が少ない前提のためGIN/pg_trgmは初期実装では未導入）
CREATE INDEX idx_compat_category_id  ON product_compatibilities (category_id);
CREATE INDEX idx_compat_product_id_1 ON product_compatibilities (product_id_1);
CREATE INDEX idx_compat_product_id_2 ON product_compatibilities (product_id_2);

-- RLS（products/categories/distributor_products と同じマスタテーブルパターン。
-- 本機能はテナント非分離＝施設スコープなし。未解決事項1を参照）
ALTER TABLE product_compatibilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "compat_select" ON product_compatibilities FOR SELECT TO authenticated USING (true);
CREATE POLICY "compat_write"  ON product_compatibilities FOR ALL    TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
  -- 未解決事項4: UPDATE(備考編集)を提供しないなら FOR ALL ではなく
  -- FOR INSERT / FOR DELETE の2ポリシーに分割し最小権限にする選択肢もある

-- refresh_schema_baseline_snapshot 呼び出し（issue #305要件・テーブル新設のため必須）
SELECT refresh_schema_baseline_snapshot('<実際のmigrationタイムスタンプ>');
```

**注意点（調査で判明した設計上の落とし穴）**
- `products` テーブルに `category_id` は存在しない。カテゴリは `distributor_products.category_id` 経由で判定する。
  → 「このカテゴリで有効な product 一覧」を取得するクエリは `distributor_products` を経由する必要がある。
- DB制約では「両製品が当該カテゴリ内に存在するか」を強制できない。アプリケーション層（API route）でバリデーションとして実装する。
- `product_id_1 < product_id_2` の CHECK により、リポジトリ層でペア挿入前に UUID を比較して小さい方を `product_id_1` に入れる正規化処理が必要。
- `product_compatibilities` は `distributor_products` への直接FKを持たない。`distributor_products` が削除されても行は残存しうるが、表示時のカテゴリ有効性判定はアプリ層フィルタ（`listProductsInCategory`）で担保する。恒久対応は別issue化する。

---

### 実装セット一覧（依存順）

#### Set A: DBマイグレーション（他セットのブロッカー）
- **ファイル**: `supabase/migrations/<実装日>_create_product_compatibilities.sql`
- **内容**: テーブル作成・インデックス・RLS・`refresh_schema_baseline_snapshot`
- **テスト観点**:
  - migration が clean apply できること（`supabase db reset` でエラーなし）
  - `product_id_1 > product_id_2` で直接INSERTすると CHECK制約違反になること
  - 自己参照（`product_id_1 = product_id_2`）で直接INSERTすると CHECK制約違反になること

#### Set B: 型定義（Set A完了後）
- **ファイル**: `src/types/compatibility.ts`
  ```typescript
  export type ProductCompatibility = {
    id: string
    categoryId: string
    categoryName: string
    productId1: string
    product1: { jan: string; name: string; maker: string | null }
    productId2: string
    product2: { jan: string; name: string; maker: string | null }
    note: string | null
    createdAt: string
    updatedAt: string
  }
  export type ProductCompatibilityInput = {
    categoryId: string
    productId1: string
    productId2: string
    note: string | null
  }
  ```
- **テスト観点**: 型定義のみ（`tsc --noEmit` でコンパイルエラーなし）

#### Set C: リポジトリ層（Set B完了後）
- **ファイル**: `src/lib/compatibilities/repository.ts`
- **内容**:
  - `listCompatibilities(db, { categoryId?: string, keyword?: string }): Promise<ProductCompatibility[]>`
    → `product_compatibilities` を JOIN（categories, products as p1, products as p2）して取得。`created_at DESC` でソート。keyword は product1/product2 の name/jan/maker を `.ilike` の OR検索（パラメータバインド、raw SQL禁止）。
  - `createCompatibility(db, input: ProductCompatibilityInput): Promise<ProductCompatibility>`
    → 挿入前に `product_id_1 < product_id_2` の正規化処理（文字列比較で小さい方を `product_id_1` に入れる）。
  - `deleteCompatibility(db, id: string): Promise<void>`
    → 対象が存在しない場合は呼び出し元（API route）で404判定できるよう、削除件数0件をハンドリング可能な形で返す。
  - `listProductsInCategory(db, categoryId: string): Promise<Product[]>`
    → `SELECT DISTINCT p.* FROM products p JOIN distributor_products dp ON dp.product_id = p.id WHERE dp.category_id = ?` で、フォームの製品選択肢取得に使用。
- **ページネーション閾値（人間レビューで決定）**: 初期実装はページネーションなし（全件取得）。`product_compatibilities` の総件数が**500件**を超えたら、ページネーション（LIMIT/OFFSET）導入を別issueで検討する。閾値到達の監視方法は本issueのスコープ外（別issueで検討）。
- **テスト観点**:
  - `createCompatibility` で同じペアを2回挿入すると 23505 エラー
  - `createCompatibility` で `productId1 > productId2` を渡した場合に正規化されること（`product_id_1 < product_id_2` になること）
  - `listCompatibilities` で `categoryId` 指定時に他カテゴリの行が含まれないこと
  - `listCompatibilities` の keyword検索が product1/product2 双方の name/jan/maker に対して機能すること
  - `deleteCompatibility` で存在しないIDを渡した場合の挙動（0件削除として判定可能なこと）

#### Set D: APIルート（Set C完了後）

**GET/POST: `src/app/api/compat/route.ts`**
- GET: `requireAuth` のみ（全認証ユーザーが読める）。クエリパラメータ: `categoryId?`, `keyword?`（最大100文字、超過は400）
- POST: `requireAuth` → `resolveIsAdmin(db, user)` → isAdmin でなければ 403
  - body: `ProductCompatibilityInput`
  - バリデーション:
    - `categoryId` / `productId1` / `productId2` は null・undefined・空文字列いずれも400
    - `categoryId` / `productId1` / `productId2` はUUID形式チェック（不正形式は400、FK到達前に弾く）
    - 自己参照チェック: 正規化前の生の値で `productId1 === productId2` を判定 → 400
    - `listProductsInCategory(db, categoryId)` の結果集合に両IDが含まれるか検証 → 含まれなければ400
    - 存在しない `categoryId` はFK違反を捕捉し「カテゴリが見つかりません」400
    - `note` は最大500文字（超過は400）
  - 重複: DB 23505 → 409「すでに登録済みです（順序問わず）。【製品A名】と【製品B名】は既に互換登録されています」（具体的なペア名を含める）
  - TOCTOU（カテゴリ検証後に対象製品がカテゴリから外れる競合）はDBのUNIQUE/FK制約を最終防壁として割り切る

**DELETE: `src/app/api/compat/[id]/route.ts`**
- `requireAuth` → `resolveIsAdmin(db, user)` → isAdmin でなければ 403
- `deleteCompatibility`、対象が存在しなければ 404

**GET: `src/app/api/compat/products/route.ts`**（フォームの製品候補取得用）
- `requireAuth`、クエリパラメータ `categoryId` 必須（UUID形式チェック、不正・欠落は400）
- `listProductsInCategory` 呼び出し
- レスポンス: `{ products: Product[] }`
- 新設理由: 既存 `/api/products` のGET仕様変更によるクライアント影響を避け、製品候補取得の責務を`/compat`ドメインに閉じるため

**テスト観点**:
- POST 一般ユーザー → 403
- DELETE 一般ユーザー → 403
- POST/DELETE/GET(products) 未認証 → 401
- POST 自己参照 → 400
- POST カテゴリ外製品 → 400
- POST 不正UUID形式（categoryId/productId1/productId2）→ 400
- POST note 501文字 → 400
- POST 重複 → 409（レスポンスに製品A名・製品B名を含む）
- DELETE 存在しないID → 404
- GET /api/compat/products の categoryId 欠落・不正UUID → 400

#### Set E: UIコンポーネント（Set D完了後）

**並列グループ宣言（E-1 と E-2 は互いに独立、並列実装可）**

**E-1: `src/components/compat/CompatList.tsx`**
- props: `{ items: ProductCompatibility[]; isAdmin: boolean; onDelete: (id: string) => void; hasFilter: boolean }`
- 表示カラム: カテゴリ名 / 製品A（名称・JAN・メーカー）/ 製品B（名称・JAN・メーカー）/ 備考 / 登録日
- 0件時の空状態メッセージを3パターンで出し分け（`items.length === 0` かつ `hasFilter` で判定）:
  - `!hasFilter && isAdmin`: 「互換品が登録されていません」＋「＋互換品を追加」導線
  - `!hasFilter && !isAdmin`: 「互換品はまだ登録されていません」
  - `hasFilter`: 「条件に一致する互換品がありません」
- `isAdmin=true` 時のみ削除ボタン表示。削除ボタン押下で確認ダイアログ（対象製品名・JAN・メーカーを含む具体的文言）を表示
- 既存 `ProductList` のテーブルスタイルを踏襲
- 一覧再取得中はスケルトンまたはスピナーを表示

**E-2: `src/components/compat/CompatForm.tsx`**
- props: `{ categories: Category[]; isAdmin: boolean; onSuccess: () => void }`
- 内部 state: `categoryId`, `productId1`, `productId2`, `note`, `productsInCategory`, `isLoadingProducts`
- `categoryId` 変更時に `/api/compat/products?categoryId=xxx` を呼び `productsInCategory` を更新。取得中は製品Select近傍にインラインスピナーを表示し、Selectを一時disabledにする
- カテゴリ未選択時は製品A・B の Select を disabled にし、プレースホルダー「先にカテゴリを選択してください」を表示
- 選択肢ラベル: `{name}（JAN: {jan}、メーカー: {maker ?? '不明'}）` 形式（一覧テーブルと表記統一）
- 製品Bの選択肢からは製品Aで選択済みの製品を除外（自己参照防止）。送信時にも `productId1 === productId2` を再検証
- 送信成功後、フォームをクリアする（モーダル使用時は閉じる）。`onSuccess()` を呼んで一覧を再取得
- 重複エラー（409）・ネットワークエラー時は画面上部にエラーメッセージを表示

#### Set F: ページ統合（Set E完了後）

**`src/app/compat/page.tsx`**（既存の Coming Soon プレースホルダを全面上書き）
- 純 `'use client'` + `useReducer(refreshKey)` + `useEffect(fetch)` 構成（`products/page.tsx` と同型。Server Component併用はしない）
- カテゴリ一覧は `useEffect` で `/api/categories` から取得
- Admin判定: `requireAuth(db)` + `resolveIsAdmin(db, user)`（クライアント側で判定が必要な場合は、既存の管理者判定を返すAPI/propの取得パターンを既存コードから確認して踏襲する）
- `categoryId`・`keyword` のフィルタ状態はコンポーネント内 state で保持（URL searchParams 連動・`useSearchParams()` は使わないため `<Suspense>` ラップは不要）
- `CompatForm`（`isAdmin=true` の場合のみ表示）と `CompatList` を配置
- ネットワークエラー時は `setError` で画面上部にエラーメッセージ表示（`products` ページと同一パターン）

**テスト観点（Set E・F共通）**:
- 一般ユーザーには「互換品を追加」フォームが表示されない
- 管理者の登録フロー一連が動作する（カテゴリ選択→製品A/B選択→登録→一覧反映→フォームクリア）
- 重複エラー時に具体的なペア名を含むメッセージが表示される
- 削除確認ダイアログに対象製品名・JAN・メーカーが含まれる
- 空状態メッセージが管理者/一般ユーザー/フィルタ結果で出し分けられる
- ネットワークエラー時に画面が壊れずエラーメッセージが表示される

#### Set G: E2Eテスト（Set F完了後）
- **ファイル**: `e2e/compat.spec.ts`（新規、既存 `e2e/products.spec.ts` を踏襲）
- 最低3シナリオ: ①一般ユーザーに「互換品を追加」ボタンが表示されない ②管理者の登録フロー ③重複登録時のエラー表示
- ダミー施設・ダミー製品のみ使用（`docs/agents/common.md` のデータ衛生ルール準拠）

---

### 並列グループ宣言（Phase 3 実装時の参考）

| グループ | セット | 触るファイル |
|---|---|---|
| G1（直列ブロッカー）| A | `supabase/migrations/<実装日>_create_product_compatibilities.sql` |
| G2（G1後）| B | `src/types/compatibility.ts` |
| G3（G2後）| C | `src/lib/compatibilities/repository.ts` |
| G4（G3後）| D | `src/app/api/compat/route.ts`, `src/app/api/compat/[id]/route.ts`, `src/app/api/compat/products/route.ts` |
| G5（G4後、E-1とE-2は並列）| E-1 | `src/components/compat/CompatList.tsx` |
| G5（G4後、E-1とE-2は並列）| E-2 | `src/components/compat/CompatForm.tsx` |
| G6（G5後）| F | `src/app/compat/page.tsx` |
| G7（G6後）| G | `e2e/compat.spec.ts` |

---

### スコープ外（今回あえて対応しない）

- 既存 API の `requireAdmin` 欠落修正（`products`/`categories`/`distributor-products`/`facilities` の PUT/DELETE）— 別issue化済み（人間レビューで決定）
- `login/page.tsx` の Suspense fallback 欠落 — 別issue化済み（人間レビューで決定）
- 互換品の閲覧権限を施設スコープにすること — 人間レビューで「不要」と決定済み。今回はテナント非分離の前提で進める
- ページネーション（LIMIT/OFFSET・cursor・無限スクロール） — 500件超過時に別issueで検討（人間レビューで決定した閾値）
- `distributor_products` 削除時の `product_compatibilities` 孤立レコード対策（直接FKなし） — 表示はアプリ層フィルタで担保し、DB整合性上の孤立は許容。恒久対応は別issue
- キーワード検索の `pg_trgm`/GIN インデックス導入 — マスタ件数が少ない前提のため初期実装では未導入。件数増大時に別issueで検討
