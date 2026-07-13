# 機能仕様書: 発注履歴ページ新設（issue #20）

作成日: 2026-07-13
ステータス: ドラフト（人間レビュー待ち、Adversarial Verifyのcritical指摘4件を反映済み）

---

## Part 1 — 仕様（人間レビュー用）

### 概要

施設内の発注履歴（症例発注・消耗品発注・短貸発注・短貸返却）を 1 つのページで横断して確認できるようにする。現在は種別ごとに別ページへ移動しないと履歴を確認できず、横断比較・検索ができない状態を解消する。

URL: `/orders`（グローバルナビゲーションからアクセス、施設ログイン後に表示）

---

### できるようになること（利用者目線）

1. **4種別の発注を1ページで一覧できる**
   - 症例発注（手術・処置で使用した医療材料の発注）
   - 消耗品発注（施設備品・消耗品の発注）
   - 短貸発注（メーカーから一時的に借用する機器・材料の発注）
   - 短貸返却（借用品の返却記録）

2. **種別タブで表示を切り替えられる**
   - タブ: 「すべて」「症例発注」「消耗品発注」「短貸発注」「短貸返却」
   - タブ選択で一覧がフィルタされる

3. **期間・キーワードで絞り込みできる**
   - 開始日・終了日（created_at ベースの範囲指定、カレンダー UI）
   - キーワード（製品名・JAN・手技名などに対するテキスト検索）

4. **短貸発注に「未返却」バッジが表示される**
   - 対応する返却記録（loan_returns）が存在しない短貸発注には「未返却」バッジを表示
   - 返却済みの場合はバッジなし

5. **ステータスが一目でわかる**
   - 症例発注・消耗品発注・短貸発注: 「下書き」「提出済」
   - 短貸返却: 「下書き」「返却済」

---

### 操作の流れ

```
1. ログイン後、グローバルナビの「発注履歴」リンクをクリック → /orders へ遷移
2. 施設に紐づく全発注が「作成日降順」で一覧表示される（初期タブ: すべて）
📸 [スクリーンショット1] 初期表示（全タブ・フィルタなし状態）

3. タブ「短貸発注」をクリック → 短貸発注のみ絞り込み表示
📸 [スクリーンショット2] 短貸発注タブ選択・「未返却」バッジ確認

4. 開始日・終了日を入力 → 期間絞り込みが反映される
5. キーワードを入力（例: 製品名）→ 一致する行のみ表示
📸 [スクリーンショット3] フィルタ適用後の絞り込み結果

6. 「クリア」ボタンでフィルタをリセット → 全件表示に戻る
```

---

### 受け入れ条件チェックリスト

#### 表示

- [ ] `/orders` にアクセスすると発注一覧が表示される
- [ ] ログインしていない状態でアクセスすると `/login` にリダイレクトされる
- [ ] 自施設の発注のみが表示される（他施設の発注は表示されない）
- [ ] 一覧は created_at 降順で表示される
- [ ] 各行に「種別」「作成日」「ステータス」「概要」が表示される
- [ ] 短貸発注行のうち、対応する返却記録がないものに「未返却」バッジが表示される
- [ ] 返却記録が存在する短貸発注には「未返却」バッジが表示されない

#### タブ操作

- [ ] タブ「すべて」選択時は4種別すべてが一覧に表示される
- [ ] タブ「症例発注」選択時は症例発注のみが表示される
- [ ] タブ「消耗品発注」選択時は消耗品発注のみが表示される
- [ ] タブ「短貸発注」選択時は短貸発注のみが表示される
- [ ] タブ「短貸返却」選択時は短貸返却のみが表示される

#### フィルタ

- [ ] 開始日を指定すると、指定日（日本時間 0:00）以降の発注のみが表示される
- [ ] 終了日を指定すると、指定日（日本時間 23:59:59）以前の発注のみが表示される
- [ ] キーワードを入力すると、製品名・JAN・手技名・メーカー名に部分一致する行が表示される（消耗品発注の場合も消耗品名で検索できる）
- [ ] 「クリア」ボタンでフィルタをリセットすると全件表示に戻る
- [ ] タブ変更後もフィルタ条件（期間・キーワード）は保持されるが、ページ位置（offset）はタブ・期間・キーワードのいずれかを変更するたびに先頭（0件目）にリセットされる

#### エラー・エッジケース

- [ ] 発注が0件の場合「発注履歴がありません」と表示される
- [ ] データ取得失敗時はエラーメッセージが表示される（画面が壊れない）
- [ ] フィルタ結果が0件の場合「条件に一致する発注がありません」と表示される

#### アクセシビリティ・レスポンシブ

- [ ] モバイル幅（375px）でも表が崩れず水平スクロールで閲覧できる
- [ ] タブがキーボード操作で切り替えられる

---

## Part 2 — 実装計画（AI用・レビュー不要）

### 前提: 現状の課題と対応方針

| 課題 | 対応 |
|---|---|
| loan_returns に loan_order_id FK がない（「未返却」判定不能） | Set A でマイグレーション追加 |
| 既存 repository に日付・キーワードフィルタなし | Set C で引数拡張 |
| 横断一覧用 API エンドポイントがない | Set D で `/api/orders` 新設 |
| Union 型・フィルタ型がない | Set B で型定義追加 |
| `useSearchParams` 使用時の Suspense 必須（既知パターン） | Set E で Suspense ラップ必須 |
| limit/offset バリデーション漏れ（既存4 route.ts） | Set D で合わせて修正 |
| consumable_orders / loan_orders / loan_returns に created_at インデックスなし | Set A のマイグレーションで追加 |

---

### 実装セット一覧（依存順）

#### Set A — DB マイグレーション（前提・最優先）

**触るファイル**:
- `supabase/migrations/YYYYMMDD_orders_history_prereqs.sql`（新規）

**内容**:
1. `loan_returns` に `loan_order_id` 列を追加:
   ```sql
   ALTER TABLE loan_returns
     ADD COLUMN loan_order_id UUID REFERENCES loan_orders(id) ON DELETE SET NULL;
   ```
   - NULL 許容（NOT NULL 不可。既存行は対応 loan_order が追跡できないため）
2. 不足インデックスを追加:
   ```sql
   CREATE INDEX IF NOT EXISTS idx_consumable_orders_facility_created_at
     ON consumable_orders (facility_id, created_at DESC);
   CREATE INDEX IF NOT EXISTS idx_loan_orders_facility_created_at
     ON loan_orders (facility_id, created_at DESC);
   CREATE INDEX IF NOT EXISTS idx_loan_returns_facility_created_at
     ON loan_returns (facility_id, created_at DESC);
   ```
3. `SELECT refresh_schema_baseline_snapshot('YYYYMMDD');` を末尾に記載
   - loan_returns テーブルに列を追加するが、テーブル新設・削除ではないため
     `known-failure-patterns.md` の「publicスキーマのテーブルを追加/削除する場合のみ必須」ルール
     を確認の上、呼び出し要否を最終判断すること

**テスト観点**:
- `supabase migration up` でエラーなく適用できる
- `loan_returns` に `loan_order_id` 列が追加され、loan_orders への FK が効いている
- loan_order_id = NULL で INSERT できる（既存行の後方互換）

---

#### Set B — 型定義追加（Set A 完了後）

**触るファイル**:
- `src/types/order.ts`（追記）

**追加する型**:
```typescript
// 発注種別識別子
export type OrderKind = 'case_order' | 'consumable_order' | 'loan_order' | 'loan_return'

// 横断一覧用サマリ型
export type OrderListItem = {
  id: string
  kind: OrderKind
  facilityId: string
  status: string      // 各種別のステータス値をそのまま文字列で保持
  summary: string     // 手技名 / 消耗品 N 品目 など、UI 表示用の概要テキスト
  createdAt: string
  unreturned?: boolean  // loan_order のみ: 対応 loan_returns が 0 件なら true
}

// フィルタ条件型
export type OrderListFilter = {
  kind?: OrderKind
  dateFrom?: string   // YYYY-MM-DD
  dateTo?: string     // YYYY-MM-DD
  keyword?: string
}
```

また `LoanReturn` 型に `loanOrderId?: string` を追加:
```typescript
export type LoanReturn = {
  // ... 既存フィールド
  loanOrderId?: string  // Set A で追加した loan_order_id FK に対応
}
```

**テスト観点**:
- `tsc --noEmit` でコンパイルエラーなし

---

#### Set C — Repository 層フィルタ拡張（Set B 完了後）

**触るファイル**:
- `src/lib/case-orders/repository.ts`（引数拡張）
- `src/lib/consumable-orders/repository.ts`（引数拡張）
- `src/lib/loan-orders/repository.ts`（引数拡張）
- `src/lib/loan-returns/repository.ts`（引数拡張 + `loanOrderId` フィールド追加）
- `src/lib/orders/repository.ts`（新規: 横断一覧取得）

**各既存 repository の変更方針**:

`listXxxOrders` の引数に `filter?: { dateFrom?: string; dateTo?: string; keyword?: string }` を追加。
既存の呼び出し元は引数省略でそのまま動作する。

```typescript
// 追加クエリ例（case_orders）
// WHY: created_at は timestamptz(UTC)だが、日付入力は施設の運用時間帯(JST)基準。
//      UTC固定で扱うと日付境界が最大9時間ずれるため、+09:00を明示してJSTの一日として解釈する
if (filter?.dateFrom) query = query.gte('created_at', `${filter.dateFrom}T00:00:00+09:00`)
if (filter?.dateTo)   query = query.lte('created_at', `${filter.dateTo}T23:59:59+09:00`)
if (filter?.keyword) {
  query = query.ilike('procedure_name', `%${filter.keyword}%`)
  // items の JAN は後段の JS 側フィルタで補完（SELECT * で items を取得済みのため）
}
```

keyword の種別ごとの対象列:
- `case_orders`: `procedure_name`、取得した `case_order_items[].jan` を JS でフィルタ
- `consumable_orders`: `.select('*, consumable_order_items(*, consumables(name, jan))')` で consumables をネストJOINして取得し、`consumables.name` / `consumables.jan` を JS でフィルタ（`summary` にも消耗品名を使う。既存の `listConsumableOrders` の戻り値には影響しない別クエリとして実装する）
- `loan_orders`: `procedure_name`, `maker`、取得した `loan_order_items[].name` を JS でフィルタ
- `loan_returns`: 取得した `loan_return_items[].jan` を JS でフィルタ

**新規 `src/lib/orders/repository.ts`**:

```typescript
export async function listOrders(
  db: SupabaseClient,
  facilityId: string,
  filter: OrderListFilter,
  limit = 50,
  offset = 0
): Promise<OrderListItem[]>
```

内部実装:
- `filter.kind` が指定された場合は該当種別のみをクエリ（残りはスキップ）
- **性能上の上限（v1スコープ）**: 各テーブルへのクエリは `ORDER BY created_at DESC LIMIT 500` を必ず付与してから
  取得する（4テーブル合計で最大2000行）。全件取得はしない。取得した最大2000行をメモリ内で
  createdAt 降順にマージソートし、`offset` から `offset + limit` 件を切り出す。
  施設単位の発注件数が2000件を大きく超える運用が確認された場合は、cursor-based pagination か
  UNION ビューへの置き換えを別issueで検討する（本issueのスコープ外）
- `unreturned` フラグ: loan_orders クエリ時に `.select('*, loan_returns!left(id)')` で LEFT JOIN し、
  `loan_returns` が空かつ `status === 'submitted'` なら `unreturned: true`
- `summary` 生成:
  - `case_order`: `procedureName`
  - `consumable_order`: 取得した `consumable_order_items[].consumables.name` を `、` 区切りで連結（例: `シリンジ、ガーゼ`）。1件も名前が取れない場合のみ `消耗品 ${items.length} 品目` にフォールバック
  - `loan_order`: `${procedureName}（${maker}）`
  - `loan_return`: `返却 ${new Date(returnDatetime).toLocaleDateString('ja-JP')}`
- **offsetのリセット**: `kind` / `dateFrom` / `dateTo` / `keyword` のいずれかが前回呼び出しと異なる場合、
  呼び出し元（UI）が `offset` を 0 にリセットしてから呼び出す。`listOrders` 自体は渡された `offset` を
  そのまま使うのみで、リセット判定はUI側（Set E）の責務とする

**テスト観点**:
- `dateFrom` / `dateTo` が JST の日境界で正しく絞り込みに反映される（例: `dateTo=2026-07-13` を指定した場合、`2026-07-13T23:59:59+09:00` = UTCで`2026-07-13T14:59:59Z`より前の行のみ含まれる）
- `keyword` が各種別の対象列に対して機能する（consumable_orderは消耗品名でも一致する）
- `kind` 指定時は指定種別のみ返す
- `unreturned: true` になる行 = submitted かつ loan_returns が 0 件の loan_order のみ
- 各テーブルへのクエリに `LIMIT 500` が付与されている
- 既存の `listCaseOrders` 等がデフォルト引数で動作する

---

#### Set D — API route 新設 + 既存バリデーション修正（Set C 完了後）

**触るファイル**:
- `src/app/api/orders/route.ts`（新規）
- `src/app/api/case-orders/route.ts`（limit/offset バリデーション修正）
- `src/app/api/consumable-orders/route.ts`（limit/offset バリデーション修正）
- `src/app/api/loan-orders/route.ts`（limit/offset バリデーション修正）
- `src/app/api/loan-returns/route.ts`（limit/offset バリデーション修正）

注: Set D の既存 route.ts 修正（バリデーション追加のみ）は Set C と独立しているため、
Wave 3 で Set C と並列実施も可能。ただし新規 `/api/orders/route.ts` は Set C 完了を要する。

**`/api/orders` GET パラメータ**:

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `facility_id` | string (UUID) | 必須 | 施設 ID |
| `kind` | `case_order` / `consumable_order` / `loan_order` / `loan_return` | 任意 | 種別フィルタ |
| `date_from` | YYYY-MM-DD | 任意 | 開始日（created_at >= date_from） |
| `date_to` | YYYY-MM-DD | 任意 | 終了日（created_at <= date_to 23:59:59） |
| `keyword` | string | 任意 | 部分一致検索 |
| `limit` | number | 任意 | デフォルト 50、上限 200 |
| `offset` | number | 任意 | デフォルト 0 |

**limit/offset バリデーション（参考実装: `/src/app/api/news/route.ts`）**:
```typescript
const rawLimit = Number(params.get('limit') ?? '50')
const rawOffset = Number(params.get('offset') ?? '0')
if (!Number.isFinite(rawLimit) || rawLimit < 1 || rawLimit > 200)
  return apiError('limit は 1〜200 の整数で指定してください', 400)
if (!Number.isFinite(rawOffset) || rawOffset < 0)
  return apiError('offset は 0 以上の整数で指定してください', 400)
```

**認可**: `requireAuth` + `requireFacilityAccess(facility_id)` — 既存パターン踏襲

**レスポンス**: `{ orders: OrderListItem[] }`

**テスト観点**:
- `facility_id` なし → 400
- 他施設の `facility_id` → 403
- `limit=NaN` / `limit=-1` / `limit=9999` → 400
- `kind=case_order` → case_orders のみが返る
- `date_from` / `date_to` / `keyword` の絞り込みが機能する

---

#### Set E — UI ページ・コンポーネント（Set D 完了後）

**触るファイル**:
- `src/app/orders/page.tsx`（新規）
- `src/components/orders/OrderHistoryTable.tsx`（新規）
- `src/components/orders/OrderHistoryFilters.tsx`（新規）
- グローバルナビゲーションファイル（実装前に `src/components/` を grep してパスを特定すること）

**`src/app/orders/page.tsx`**:
- `useSearchParams` を使うため Suspense でラップ必須（既知パターン）
```typescript
'use client'
import { Suspense } from 'react'

export default function OrdersPage() {
  return (
    <Suspense fallback={<p className="text-sm" style={{ color: '#6B7280' }}>読み込み中...</p>}>
      <OrdersPageInner />
    </Suspense>
  )
}
```

**タブ実装方針**:
- タブ状態は URL searchParams（`?kind=loan_order`）で管理 → ブラウザバック対応
- `useSearchParams` で現在の kind を読み、タブ UI に反映
- タブ変更時は `router.push` で URL を更新し、`offset` パラメータを URL から削除する（先頭ページに戻す）

**フィルタ実装方針**:
- `OrderHistoryFilters` コンポーネントに `dateFrom`, `dateTo`, `keyword` の入力欄
- 変更時に `router.push` で URL を更新し、`offset` パラメータを URL から削除する（先頭ページに戻す）
- 「クリア」ボタンで全 searchParams を削除（`offset` も含めて全リセット）

**データ取得**:
- `useEffect` 内で `/api/orders?facility_id=...` を fetch
- `facility_id` の取得方法: 既存の `/facilities/[id]/...` ページが `use(params)` で facility id を取得しているパターンとは異なり、`/orders` はグローバルページのため、セッションまたはコンテキストから施設 ID を取得する方法を既存コードで確認すること（`src/components/` や `src/lib/supabase/` を参照）

**一覧表示列**:

| 列 | case_order | consumable_order | loan_order | loan_return |
|---|---|---|---|---|
| 種別バッジ | 症例発注 | 消耗品発注 | 短貸発注 | 短貸返却 |
| 概要 | 手技名 | 消耗品 N 品目 | 手技名・メーカー | 返却日時 |
| ステータス | 下書き / 提出済 | 下書き / 提出済 | 下書き / 提出済 | 下書き / 返却済 |
| 未返却 | — | — | バッジ（該当時） | — |
| 作成日 | createdAt | createdAt | createdAt | createdAt |

**ステータスラベルマップ**:
```typescript
const STATUS_LABEL: Record<string, string> = {
  draft: '下書き',
  submitted: '提出済',
  returned: '返却済',
}
```

**テスト観点**:
- `useSearchParams` が Suspense の内側にある
- タブクリックで URL が更新され、データが再取得される
- `unreturned: true` の行に「未返却」バッジが表示される
- `unreturned: false / undefined` の行にバッジが表示されない
- エラー時にエラーメッセージが表示される（画面が壊れない）
- モバイル幅（375px）でテーブルが水平スクロールする
- キーボードでタブ切り替えができる

---

### 並列グループ宣言

```
Wave 1（順次・必須前提）:
  - Set A (DB マイグレーション)

Wave 2（Set A 完了後）:
  - Set B (型定義)
    触るファイル: src/types/order.ts

Wave 3（Set B 完了後・以下2セットは並列可能）:
  - Set C (Repository 拡張)
    触るファイル: src/lib/case-orders/repository.ts
                  src/lib/consumable-orders/repository.ts
                  src/lib/loan-orders/repository.ts
                  src/lib/loan-returns/repository.ts
                  src/lib/orders/repository.ts（新規）

  - Set D-fix（既存バリデーション修正・Set C と独立）
    触るファイル: src/app/api/case-orders/route.ts
                  src/app/api/consumable-orders/route.ts
                  src/app/api/loan-orders/route.ts
                  src/app/api/loan-returns/route.ts

Wave 4（Set C 完了後）:
  - Set D-new（新規 /api/orders ルート）
    触るファイル: src/app/api/orders/route.ts（新規）

Wave 5（Set D 完了後）:
  - Set E（UI ページ・コンポーネント）
    触るファイル: src/app/orders/page.tsx（新規）
                  src/components/orders/OrderHistoryTable.tsx（新規）
                  src/components/orders/OrderHistoryFilters.tsx（新規）
                  グローバルナビゲーションファイル（パスは実装前に確認）
```

---

### 実装スコープ外（この issue では対応しない）

| 項目 | 理由 |
|---|---|
| 発注詳細画面 | issue #20 スコープ外。別 issue 推奨 |
| loan_return_items での品目単位の返却追跡 | DB 設計変更を伴う。別 issue 推奨 |
| consumable_order の keyword 検索でのネスト JOIN | 実装難度・効果のバランス。Phase 2 で検討 |
| 既存4施設別ページとの統合 | UX 整合の判断が必要。別 issue 推奨 |
| loan_returns repository の atomic RPC 移行 | 調査で発見したバグだが本 issue スコープ外。別 issue 起票推奨 |

---

## Part 3 — 仕様レビュー前セルフチェック（AI用・レビュー不要）

### 新型・enum・statusフィールドの判定基準確認

**OrderKind**（新規 enum）:

| 値 | 意味 | 判定基準 |
|---|---|---|
| `case_order` | 症例発注 | case_orders テーブルから取得した行 |
| `consumable_order` | 消耗品発注 | consumable_orders テーブルから取得した行 |
| `loan_order` | 短貸発注 | loan_orders テーブルから取得した行 |
| `loan_return` | 短貸返却 | loan_returns テーブルから取得した行 |

下流の反応:
- タブ UI: OrderKind の各値でタブ表示をフィルタ。全値を網羅したタブが存在する（すべて + 4種別 = 5タブ）
- API `kind` パラメータ: 値が一致する種別のみクエリ。一致しない値は 400 を返す
- `OrderHistoryTable`: 種別バッジの色・ラベルを kind で分岐

**status（既存値・種別依存）**:
- `draft` / `submitted`: case_orders / consumable_orders / loan_orders
- `draft` / `returned`: loan_returns
- 下流: `OrderListItem.status` に文字列格納、`STATUS_LABEL` マップで日本語変換
- 既存 status 値を変更しないため、他の下流（既存施設別ページ）への影響なし

**unreturned フラグ**:

| 値 | 判定条件 | UI の反応 |
|---|---|---|
| `true` | `loan_order.status === 'submitted'` かつ loan_returns が 0 件 | 「未返却」バッジを表示 |
| `false` または `undefined` | それ以外すべて（draft / 返却済 / loan_order 以外の種別） | バッジなし |

下流: `OrderHistoryTable` コンポーネントのみが消費。stats・レポート・後続フェーズへの影響なし。

### 包含・除外リスト確認

タブ数: 5（すべて・症例発注・消耗品発注・短貸発注・短貸返却）= OrderKind の4種別 + 全体タブ 1 件 = 計5件。本文「タブ: 「すべて」「症例発注」「消耗品発注」「短貸発注」「短貸返却」」の記述と一致。

### 既存ロジック影響確認

- 既存 `/api/case-orders` 等の limit/offset バリデーション修正: 呼び出し元の施設別ページは `limit`/`offset` をデフォルト省略で呼ぶため影響なし（デフォルト値 50 / 0 は有効範囲内）
- `listCaseOrders` 等への `filter` 引数追加: オプショナルなため既存呼び出し元に変更不要
- `LoanReturn` 型への `loanOrderId?: string` 追加: オプショナルなため既存コンポーネント（`LoanReturnModal.tsx`）に変更不要
