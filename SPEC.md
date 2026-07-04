# SPEC: 業務ダッシュボード（トップページ置き換え / Issue #19）

---

## Part 1 — 仕様（★人間がレビューする部分）

### 何ができるようになるか

ログイン後に表示されるトップページ（現在はcreate-next-appのデフォルト画面）が、日々の業務状況を一目で把握できる「業務ダッシュボード」に置き換わります。

- 自分が所属する施設ごとに、直近の発注（貸出・消耗品・症例）の状況が一覧で見える
- 「返してもらっていない貸出品」が施設ごとに件数で分かる
- 最近、仕切値・納入価格・償還価格が変わった商品が分かる
- 各管理画面（施設一覧・商品一覧・発注一覧など）へワンクリックで移動できる

### 画面イメージ / 操作の流れ

ログイン → 自動的に `/`（トップ）へ遷移 → ダッシュボードが表示される。

**セクション構成（上から順）**

1. **施設別 直近発注サマリー**
   - 自分の所属施設ごとにカードを表示
   - 各カードに、直近の症例発注・消耗品発注・貸出発注の件数と最新日時
   - カードをクリックすると該当施設の発注一覧へ遷移

   📸 施設カードが自分の所属施設数だけ表示されていること

2. **未返却の貸出件数**
   - 施設ごとに「未返却件数」をバッジ表示
   - 未返却件数 = 提出済み（submitted）の貸出発注に対して、対応する返却（returned）が完了していない件数
   - 0件の施設は「未返却なし」と表示、1件以上は警告色で強調

   📸 未返却件数バッジが施設ごとに表示され、0件と1件以上で見た目が区別されていること

3. **最近の価格改定**
   - 直近の価格改定（仕切値・納入価格・償還価格の変更）を新しい順に最大10件表示
   - 商品名・変更項目・変更前後の値・変更日時を表示
   - 該当商品の価格改定履歴ページへのリンクあり

   📸 価格改定一覧が新しい順に並んでいること

4. **管理ページへのショートカット**
   - 施設一覧・商品一覧・販売店商品一覧・病院価格一覧・カテゴリ一覧へのボタンリンク
   - admin権限を持つユーザーには管理ユーザーページへのリンクも追加表示

   📸 ショートカットボタンから各管理ページへ遷移できること

### 受け入れ条件（チェックリスト）

- [ ] `/` にログイン後アクセスすると、Next.jsデフォルトテンプレートではなく業務ダッシュボードが表示される
- [ ] 自分が所属していない施設のデータは表示されない（施設間データ隔離）
- [ ] **【必須・明示テスト】異なる施設に所属する2人のテストユーザーでログインし比較する。施設Aのユーザーには施設Bの発注サマリー・未返却件数・施設固有の価格改定（hospital_price）が一切表示されないことをPlaywright MCPまたは手動で確認する。既存コードで同種の施設フィルタ漏れ（`listHospitalPrices`）が実際に見つかっているため、新規実装での再発がないことを実装後に必ず確認する**
- [ ] 未認証で `/` にアクセスすると `/login` にリダイレクトされる（既存middlewareの挙動を維持）
- [ ] 施設別サマリー・未返却件数・価格改定一覧・ショートカットの4セクションが表示される
- [ ] 各カード・リンクから対応する既存ページへ正しく遷移する
- [ ] 表示対象データが0件のセクションは「データがありません」等の空状態表示になる（エラーにならない）
- [ ] 新規テーブルを追加しない（既存データのみで実装。`price_histories`テーブルは2026-06-22のマイグレーションで既に作成済みで、`distributor_products`/`hospital_prices`更新時にDBトリガーで自動記録されているため、新規テーブルなしで「最近の価格改定」表示は実現可能——確認済み）

### 備考（今回のスコープ外・別issue化を推奨）

Phase 1調査で以下の**既存バグ**が見つかりました。ダッシュボード機能の実装対象には含めず、別issueとして切り出すことを推奨します。

- `products` / `facilities` / `categories` / `distributor-products` / `hospital-prices` の `[id]/route.ts` の GET/PUT/DELETE に認証チェック（`requireAuth`）が無い
- `listHospitalPrices(db)` が `facility_id` でフィルタされておらず、全施設の価格情報が露出するリスクがある
- 各種フォーム・一覧ページで `res.json()` のエラーハンドリングが薄く、HTTPエラー時に例外が発生しうる
- repository層でDBのenum値をunsafe castしている箇所が複数ある（`mapping.ts`の`asEnum()`未活用）

---

## Part 2 — 実装計画（AI用・レビュー不要）

### 前提となる既存実装

- `requireAuth(db)`: `src/lib/supabase/require-auth.ts` — 未認証時は`Error('UNAUTHORIZED')`
- `requireFacilityAccess(db, user, facilityId)`: `src/lib/supabase/require-facility-access.ts` — admin全許可／非adminは所属施設のみ
- `listCaseOrders` / `listConsumableOrders` / `listLoanOrders` / `listLoanReturns`: 各 `src/lib/*/repository.ts` に `(db, facilityId, limit, offset)` シグネチャで存在（施設単位・最新N件取得に流用可）
- `listFacilities(db)`: `src/lib/facilities/repository.ts` — 全施設取得（所属フィルタなし）
- ユーザー所属施設一覧の取得ロジックは存在しない → 新設が必要
- 「全体横断の最近の価格改定」取得関数は存在しない → 新設が必要
- 「未返却貸出」を突合する自動ロジックは存在しない → 新設が必要（`loan_order_items`と`loan_return_items`に直接の外部キーはないため、施設単位で `submitted` の貸出発注件数 − `returned` の返却件数 の差分をビジネスルールとして定義する）

### 施設間データ隔離の方針（Confirmed）

- `price_histories` テーブルは `20260622000000_add_price_histories.sql` で作成済み。`distributor_products.reimbursement_price` と `hospital_prices.purchase_price/delivery_price` の更新時にDBトリガーで自動的に履歴行がINSERTされる。**新規テーブル不要の制約を満たすことを確認済み**。
- `20260627010000_add_multitenant.sql` のRLSポリシー`facility_member_only`（price_historiesテーブル）は、`entity_type='hospital_price'`の行を`hospital_prices.facility_id`経由で施設メンバーのみに絞り、`entity_type='distributor_product'`の行は全認証ユーザーに公開する設計になっている（`reimbursement_price`は施設非依存の商品マスタ属性のため、これは意図的な設計であり、Phase1 Sweepが指摘した「設計意図不明」は今回の調査で意図的と判断できた）。
- **重要**: `src/lib/supabase/server.ts` の `createServerSupabase()`（anon key + セッションcookie）を使う限り、上記RLSがPostgres側で自動適用される。`createAdminSupabase()`（service_role、RLSバイパス）は本機能の実装では使用しないこと。Set 1〜5の新規repository/APIルートはすべて`createServerSupabase()`経由のクライアントを受け取って動作させ、アプリ側で追加のfacility_idフィルタを重ねて信頼性を担保する（RLS一本に依存しない多層防御）。
- Set 5（APIルート）のテスト観点に追加: 異なる施設に所属する2ユーザーで実際にダッシュボードAPIを呼び出し、互いの施設データ（発注サマリー・未返却件数・hospital_price系の価格改定）が混入しないことを検証する統合テスト、およびPhase 5でのPlaywright/手動確認を必須とする。

### 実装セット一覧（依存順）

**Set 0: 契約（型定義）** [contract-writer]
- `src/types/dashboard.ts` 新設: `DashboardFacilitySummary`, `LoanOutstandingSummary`, `RecentPriceChange`, `DashboardData` 型を定義
- 触るファイル: `src/types/dashboard.ts`（新規）

**Set 1: user_facilities からユーザー所属施設一覧を取得するロジック** [波A]
- `src/lib/user-facilities/repository.ts` 新設: `listUserFacilities(db, userId): Promise<{facilityId, facilityName, role}[]>`
- テスト観点: 所属施設が0件/複数件/adminロール混在のケース
- 触るファイル: `src/lib/user-facilities/repository.ts`（新規）, `src/lib/user-facilities/repository.test.ts`（新規）

**Set 2: 施設別直近発注サマリー取得ロジック** [波A]
- `src/lib/dashboard/facility-summary.ts` 新設: 施設IDを受け取り、既存の`listCaseOrders`/`listConsumableOrders`/`listLoanOrders`を`limit=1`で呼び出し、件数・最新日時を集約する`getFacilityOrderSummary(db, facilityId)`
- テスト観点: 発注が1件もない施設、3種類すべて存在する施設
- 触るファイル: `src/lib/dashboard/facility-summary.ts`（新規）, `.test.ts`（新規）

**Set 3: 未返却貸出件数の算出ロジック** [波A]
- `src/lib/dashboard/loan-outstanding.ts` 新設: `getLoanOutstandingCount(db, facilityId)` — `submitted`状態の`loan_orders`件数と`returned`状態の`loan_returns`件数の差分を算出（0未満は0に丸める）
- テスト観点: 提出0件、提出>返却、提出=返却、返却>提出（丸め確認）
- 触るファイル: `src/lib/dashboard/loan-outstanding.ts`（新規）, `.test.ts`（新規）

**Set 4: 全体横断の最近の価格改定取得ロジック** [波A]
- `src/lib/price-histories/repository.ts` に `listRecentPriceHistories(db, limit=10): Promise<PriceHistory[]>` 追加（`price_histories`を`changed_at`降順で直接クエリ、既存の`asEnum()`パターンに寄せて型安全にする）
- テスト観点: 0件、limit超過時の件数丸め、`entityType`/`fieldName`のenum安全性
- 触るファイル: `src/lib/price-histories/repository.ts`（既存ファイルへの追記）, `src/lib/price-histories/repository.test.ts`（既存）
- ※ 既存ファイルを触るため波Aには含めず、Set 1-3と同時実装せずこのセット単独で実装する（他セットはこのファイルを触らないため実質は独立して並列可）

**Set 5: ダッシュボード用APIルート** [統合ゲート]
- `src/app/api/dashboard/route.ts` 新設: `requireAuth` → `listUserFacilities` → 各施設について `getFacilityOrderSummary` + `getLoanOutstandingCount` を集約 → `listRecentPriceHistories` → `DashboardData` を返す
- テスト観点: 未認証401、所属施設0件、正常系のレスポンス形状
- 触るファイル: `src/app/api/dashboard/route.ts`（新規）, `.test.ts`（新規） — Set 1〜4すべてに依存するため統合ゲートで実装

**Set 6: ダッシュボードUI（トップページ置き換え）** [統合ゲート]
- `src/app/page.tsx` を全面置き換え: `'use client'` + `useEffect`で`/api/dashboard`をfetch（`res.ok`チェック徹底）、4セクションを既存UI規約（`#072C2C`見出し・`#FF5F03`アクセント・`rounded bg-white shadow-sm`カード）に沿って表示
- テスト観点: ローディング状態、空状態、正常表示、fetch失敗時のエラー表示
- 触るファイル: `src/app/page.tsx`（既存ファイルの全面置き換え）, `src/app/page.test.tsx`（新規/既存）

### 並列グループ宣言

- **波A（同時実装可）**: Set 1（user_facilities repository）, Set 2（facility-summary）, Set 3（loan-outstanding）— それぞれ独立した新規ファイルのみを触るため並列可
- **単独実装**: Set 4（price-histories repository への追記）— 既存共有ファイルを触るため波Aとは別枠だが、他セットと依存関係がないため並列着手自体は可能（統合時のコンフリクトのみ注意）
- **統合ゲート（Phase 4）**: Set 5（APIルート、Set 0〜4すべてに依存）→ Set 6（UI、Set 5に依存）は直列。Set 0（型定義）は最初にcontract-writerが確定し、Set 1〜4が参照する。
