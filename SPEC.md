# 機能仕様書: 分析・レポートページの新設（issue #23）

作成日: 2026-07-15
ステータス: ドラフト（人間レビュー待ち。Adversarial Verify 55件＋Judge Panel統合案を反映済み）

---

## ⚠️ 人間が判断すべき未解決事項（レビュー時に必ず確認）

以下はAI側で仮決定しているが、承認前に確認をお願いします（1・2は既に人間確認済み）。

1. **【確認済み】単価の取得方法**: 発注**作成時**（`create_*_order_atomic` RPC内）に単価をスナップショット保存する方式で進める。過去の発注（本機能実装日より前）は単価データがなく、集計上「-」表示になる。
2. **【確認済み】集計対象ステータス**: `draft`/`submitted`を問わず全発注を集計対象にする（現状submitフロー自体が存在しないため）。将来submitフローが実装されたら、WHERE句一行で絞り込める設計にしておく。
3. **複数`distributor_products`が同一JANに紐づく場合の単価選択ルール**: 本ドラフトは`MIN(purchase_price)`（最安値・決定論的）を採用と仮決定。曖昧な場合にNULL（保存しない）にする案もある。金額の正確性に関わるため確認を推奨。
4. **NULL/¥0/「-」の表示区分**: 本ドラフトは以下の3区分で仮決定。表示文言は要確認。
   - 発注0件 → 「-」
   - 発注はあるが全明細のunit_price=NULL（金額データなし）→ 「-（金額データなし）」
   - 金額集計値が0円（数量0等）→ 「¥0」
5. **ページ初回表示**: 性能懸念のため、初回アクセス時は自動集計せず「期間未指定＝空状態（フィルタ入力待ち）」とする仮決定。全期間自動集計にすべきかは要確認。
6. **監査ログ**: admin による全施設金額閲覧の監査ログは今回スコープ外（コンプライアンス要件があれば別途検討）。
7. **過去データの遡及計算**: 行わない（実装日以前の発注は永続的に「-」）。遡及必要なら別issue。

---

## Part 1 — 仕様（人間レビュー用）

### 何ができるようになるか（利用者目線）

admin ユーザーのみが `/admin/reports` にアクセスし、任意の期間を指定して「施設別 × 発注種別（症例発注 / 消耗品発注 / 短貸発注）の発注金額集計テーブル」を閲覧できる。一般ユーザーはこのページへのリンク・ナビゲーションが表示されず、URLを直打ちしても`/login`にリダイレクトされる（`/admin/*`の既存adminガードをそのまま利用するため、ページを`/admin/reports`に配置する）。

価格推移グラフは今回のスコープ外（別issueで検討）。

### 操作の流れ

1. adminユーザーが `/admin/reports` にアクセスする
2. ページ上部に期間フィルタ（開始日・終了日、任意入力）が表示される
3. 「集計する」ボタン押下、またはURLパラメータ変更で集計テーブルが更新される
4. テーブルは「施設名」行 × 「症例発注金額 / 消耗品発注金額 / 短貸発注金額 / 合計」列の形式で表示される（全施設が行として表示され、発注0件の施設も表示する）
5. 金額はすべて円表示（カンマ区切り整数）
6. 該当データがない場合は「-」、金額データなしの場合は「-（金額データなし）」、集計値0円は「¥0」と表示を区別する（未解決事項4）

### 受け入れ条件チェックリスト

**アクセス制御**
- [ ] adminユーザーが `/admin/reports` にアクセスできる
- [ ] 未認証ユーザーが `/admin/reports` にアクセスすると `/login` にリダイレクトされる
- [ ] 一般ユーザーが `/admin/reports` にアクセスすると `/login` にリダイレクトされる（middlewareのadminガードで弾かれる。middleware自体の改修は不要）
- [ ] `DashboardShortcuts` に「レポート」リンクがadminユーザーのみに表示される（一般ユーザーには非表示）
- [ ] 一般ユーザーが `GET /api/admin/reports` に直接リクエストすると403が返る
- [ ] 未認証リクエストは401が返る

**期間フィルタ**
- [ ] 開始日・終了日をYYYY-MM-DD形式で任意指定できる（両方省略時は全期間）
- [ ] 開始日のみ指定時は「指定日(JST 00:00:00)以降」、終了日のみ指定時は「指定日(JST 23:59:59)以前」として集計される（`src/lib/jst-date-range.ts`の`jstDayStart`/`jstDayEnd`/`isValidDateString`を再利用する。独自実装しない）
- [ ] 開始日 > 終了日の場合はバリデーションエラーを表示し、APIは呼ばない
- [ ] 不正な日付形式は400エラーになる

**集計テーブル**
- [ ] 全施設が行として表示される（発注が0件の施設も表示する）
- [ ] 列は「施設名 / 症例発注金額 / 消耗品発注金額 / 短貸発注金額 / 合計」の5列
- [ ] 各金額セルは該当期間・施設・発注種別の `unit_price × quantity` のSUM（ステータスは問わず全件対象。未解決事項2）
- [ ] 発注0件の施設は「-」、発注はあるが単価データが一切ない場合は「-（金額データなし）」、集計値が0円の場合は「¥0」と表示が区別される（未解決事項4）
- [ ] 合計列は各種別のNULLを0とみなして加算する。ただし全種別が「発注0件」の場合は合計も「-」
- [ ] ページ下部に「YYYY-MM-DD以前の発注は金額データがありません」旨の注釈を表示する
- [ ] 集計中はテーブル領域にローディング表示をする

**データ精度**
- [ ] 発注作成時（`create_*_order_atomic` RPC内）に単価スナップショットが保存されている
- [ ] 単価解決に失敗した場合（該当する`hospital_prices`が存在しない等）は`unit_price=NULL`として保存し、発注作成自体は失敗させない（best-effort）

---

## Part 2 — 実装計画（AI用）

### 設計方針の確定事項（Judge Panel採用: 保守的設計アプローチ、スコア77）

| 論点 | 採用 | 理由 |
|---|---|---|
| ページ配置 | `/admin/reports` | `src/middleware.ts`の`isAdminPath`は`/admin/*`のみ対応。middleware改修なしでadminガードを効かせるため |
| 単価保存タイミング | 発注**作成時**（`create_*_order_atomic` RPC内） | 現状submitフローが存在しないため（未解決事項2で確定） |
| 集計対象ステータス | 問わず全件 | 同上。将来submitフロー実装時にWHERE句一行で絞れる設計にしておく |
| JST日付変換 | `src/lib/jst-date-range.ts`を再利用 | 既存の`jstDayStart`/`jstDayEnd`/`isValidDateString`と重複実装しない |
| 単価解決パス | `case_order_items.jan → products(jan) → distributor_products(product_id) → hospital_prices(distributor_product_id, facility_id)` | 実際のスキーマに基づく正しいJOINパス（`hospital_prices`は`distributor_product_id`+`facility_id`で一意） |
| 認可 | API層`requireAdmin()`（403）+ RPC層`is_admin()`（permission denied→403変換） | 既存`admin-auth.ts`パターンを踏襲。`createAdminSupabase()`は不要 |

不採用（検討したが見送り）: クエリ時に現在の`hospital_prices`をJOINして計算する方式（未解決事項1で確定）。過去発注の履歴的単価精度が失われるため。

---

### DB設計

#### Set A: 既存order_itemsテーブルへの単価カラム追加

```sql
-- migration: <実装日>_add_unit_price_to_order_items.sql
ALTER TABLE case_order_items       ADD COLUMN unit_price NUMERIC(12,2);
ALTER TABLE consumable_order_items ADD COLUMN unit_price NUMERIC(12,2);
ALTER TABLE loan_order_items       ADD COLUMN unit_price NUMERIC(12,2);

-- 既存データはNULL（過去発注は金額データなし）。カラム追加のみでテーブル新設/削除ではないため
-- refresh_schema_baseline_snapshot は不要（issue #305要件の対象外。実装時に最新スキーマベースラインで再確認すること）

-- 20260714000005_orders_history_prereqs.sql が consumable_orders/loan_orders/loan_returns の
-- (facility_id, created_at)複合インデックスを追加済みだが、case_ordersが欠落している（本migrationで補う）
CREATE INDEX IF NOT EXISTS idx_case_orders_facility_created_at
  ON case_orders (facility_id, created_at DESC);
```

**注意点**: `unit_price`はNUMERIC(12,2)（円未満は扱わないが、将来の消費税等端数対応に備え小数2桁を確保）。既存行はNULLのまま（遡及なし、未解決事項7）。

#### Set A-2: 既存の発注作成RPC改修（単価スナップショット保存）

- **触るファイル**: `supabase/migrations/<実装日>_add_unit_price_snapshot_to_order_rpcs.sql`（新規。既存migrationファイルは追記・修正禁止のため`CREATE OR REPLACE FUNCTION`で対応）
- 対象: `create_case_order_atomic` / `create_consumable_order_atomic` / `create_loan_order_atomic`（`supabase/migrations/20260626002000_add_order_rpc_functions.sql` 等で定義済み）
- 各RPC内で、各明細行の挿入前に単価を解決してINSERTする:
  - `case_order_items`: `jan → products(jan) → distributor_products(product_id) → hospital_prices(distributor_product_id, p_facility_id)` で`purchase_price`を取得
  - `consumable_order_items`: `consumable_id → consumables(jan) → products(jan) → distributor_products(product_id) → hospital_prices(...)`
  - `loan_order_items`: `case_order_items`と同型
  - 同一JANが複数`distributor_products`に紐づく場合は`MIN(purchase_price)`を採用（未解決事項3）
  - 単価解決に失敗した場合（該当行なし・`consumables.jan`がNULL等）は`unit_price = NULL`のまま挿入し、例外を投げない（best-effort、RPCはロールバックしない）
- **テスト観点**:
  - 正常な単価解決で`unit_price`が正しく保存される
  - 該当する`hospital_prices`がない場合、`unit_price=NULL`で挿入が成功する（例外にならない）
  - 同一JANが複数distributor_productsに紐づく場合、`MIN(purchase_price)`が採用される

#### Set B: 集計RPC

- **触るファイル**: `supabase/migrations/<実装日>_add_order_amount_report_rpc.sql`
- RPC名: `get_order_amount_report(p_date_from TIMESTAMPTZ, p_date_to TIMESTAMPTZ)`
- 戻り値型:
  ```sql
  TABLE(
    facility_id UUID,
    facility_name TEXT,
    case_order_amount NUMERIC,
    case_order_count INTEGER,
    consumable_order_amount NUMERIC,
    consumable_order_count INTEGER,
    loan_order_amount NUMERIC,
    loan_order_count INTEGER
  )
  ```
  - `*_count`は「単価データがある明細の件数」。0件と「発注はあるが単価データなし」をUI側で区別するために必要（未解決事項4）
- 実装方針:
  - `SECURITY DEFINER` + `SET search_path = public` + 関数冒頭で`is_admin()`チェック（false なら`RAISE EXCEPTION 'permission denied'`）
  - `GRANT EXECUTE ON FUNCTION get_order_amount_report TO authenticated, service_role`（`anon`除外。実行時の最終ガードは関数内`is_admin()`）
  - `facilities`テーブルを起点にLEFT JOINし、全施設が必ず出力される
  - 各発注種別は`WHERE (p_date_from IS NULL OR created_at >= p_date_from) AND (p_date_to IS NULL OR created_at <= p_date_to)`（ステータス条件なし、未解決事項2）
  - `SUM(unit_price * quantity) FILTER (WHERE unit_price IS NOT NULL)`で集計、NULLはNULLのまま返す（COALESCEしない。UI側で判定）
- **テスト観点**:
  - adminユーザーで実行できる
  - 非adminユーザーでpermission deniedが返る
  - 期間フィルタが正しく適用される（境界値含む）
  - 発注0件の施設はNULL・countも0で返る
  - 発注はあるが単価データなしの施設はNULL・count=0で返る

#### Set C: 型定義・Repository

- **触るファイル**:
  - `src/types/report.ts`（新規）
  - `src/lib/reports/repository.ts`（新規）
  - `src/lib/reports/__tests__/repository.test.ts`（新規）
- 型定義:
  ```typescript
  export type OrderAmountReportRow = {
    facilityId: string
    facilityName: string
    caseOrderAmount: number | null
    caseOrderCount: number
    consumableOrderAmount: number | null
    consumableOrderCount: number
    loanOrderAmount: number | null
    loanOrderCount: number
  }
  export type OrderAmountReportFilter = {
    dateFrom?: string  // YYYY-MM-DD
    dateTo?: string    // YYYY-MM-DD
  }
  ```
- `fetchOrderAmountReport(db: SupabaseClient, filter: OrderAmountReportFilter): Promise<OrderAmountReportRow[]>`
  - `filter.dateFrom`/`dateTo`は`jstDayStart`/`jstDayEnd`でTIMESTAMPTZに変換してから`db.rpc('get_order_amount_report', {...})`を呼ぶ
  - スネークケース→キャメルケースへの全フィールドマッピングをテストでアサートする（マッピング漏れ防止）
- **テスト観点**: RPC呼び出しが正しい引数で呼ばれること、レスポンス全フィールドのマッピングが正しいこと

#### Set D: APIエンドポイント

- **触るファイル**:
  - `src/app/api/admin/reports/route.ts`（新規）
  - `src/app/api/admin/reports/__tests__/route.test.ts`（新規）
- `GET /api/admin/reports?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD`
- 認可: `requireAdmin()`（`createServerSupabase()`経由、`createAdminSupabase()`は不要）→ 403
- バリデーション:
  - `date_from`/`date_to`は省略可。指定時は`isValidDateString()`でYYYY-MM-DD形式チェック（不正形式は400）
  - `date_from > date_to`の場合は400
  - RPCからの`permission denied`はAPIが403に変換する（500で隠さない）
- レスポンス: `{ rows: OrderAmountReportRow[] }`
- **テスト観点**: 未認証401・非admin403・不正日付400・正常系

#### Set E: UIコンポーネント

- **触るファイル**:
  - `src/components/reports/ReportFilters.tsx`（新規）: 期間フィルタUI。バリデーションエラー表示含む
  - `src/components/reports/ReportTable.tsx`（新規）: 集計テーブル。`caseOrderCount === 0 && caseOrderAmount === null`なら「-（金額データなし）」、行自体の全種別が発注0件なら「-」、集計値0円は「¥0」と判定して表示（未解決事項4のルールを実装）
  - `src/components/reports/__tests__/ReportFilters.test.tsx`（新規）
  - `src/components/reports/__tests__/ReportTable.test.tsx`（新規）
- **テスト観点**: NULL/0/「-（金額データなし）」の3パターンが正しく出し分けられること、金額がカンマ区切り円表示されること、日付バリデーションが機能すること

#### Set F: ページ・ナビ統合

- **触るファイル**:
  - `src/app/admin/reports/page.tsx`（新規）
  - `src/app/admin/reports/__tests__/page.test.tsx`（新規）
  - `src/components/dashboard/DashboardShortcuts.tsx`（既存・改修）
- `page.tsx`実装方針:
  - `useSearchParams()`を使う場合は`<Suspense>`必須ラップ（`src/app/orders/page.tsx`パターン参照）
  - 初回アクセス時（`date_from`/`date_to`ともURLパラメータなし）は自動集計せず空状態（フィルタ入力待ち）を表示する（未解決事項5）
  - `/api/admin/reports`をfetchして`ReportTable`に渡す
- `DashboardShortcuts.tsx`改修（重要な既存コード注意点）:
  - 現行は`const ADMIN_SHORTCUT = { href:'/admin/users', label:'管理ユーザー' }`という**単一オブジェクト**を`[...BASE_SHORTCUTS, ADMIN_SHORTCUT]`でスプレッドしている
  - `ADMIN_SHORTCUTS`という**配列**（`[{ href:'/admin/users', ... }, { href:'/admin/reports', label:'レポート' }]`）に定義し直し、呼び出し側を`[...BASE_SHORTCUTS, ...ADMIN_SHORTCUTS]`（二重スプレッド）に変更する。単純に配列へ差し替えるだけだと`[...BASE, [...]]`になり型が壊れるため注意
- **テスト観点**: adminユーザーには「レポート」リンクが表示される、一般ユーザーには非表示であること、ページのローディング/エラー状態が機能すること

---

### 並列グループ宣言

| グループ | セット | 触るファイル |
|---|---|---|
| G1（並列可）| A | `supabase/migrations/<実装日>_add_unit_price_to_order_items.sql` |
| G1（並列可）| A-2 | `supabase/migrations/<実装日>_add_unit_price_snapshot_to_order_rpcs.sql` |
| G2（G1後）| B | `supabase/migrations/<実装日>_add_order_amount_report_rpc.sql` |
| G3（G2後）| C | `src/types/report.ts`, `src/lib/reports/repository.ts` |
| G4（G3後、DとEは並列可）| D | `src/app/api/admin/reports/route.ts` |
| G4（G3後、DとEは並列可）| E | `src/components/reports/ReportFilters.tsx`, `src/components/reports/ReportTable.tsx` |
| G5（G4後）| F | `src/app/admin/reports/page.tsx`, `src/components/dashboard/DashboardShortcuts.tsx` |

---

### 触れないファイル（実装者は変更禁止）

- `src/middleware.ts`（`/admin/reports`配置により既存adminガードで対応済み。改修不要）
- `src/types/order.ts`（既存の`OrderListItem`等は変更しない）
- 既存のマイグレーションファイル（追記・修正禁止。RPC改修は`CREATE OR REPLACE FUNCTION`による新規migrationで対応）

---

### スコープ外（今回あえて対応しない）

- 価格推移グラフ（issue本文にも明記。別issueで検討）
- CSVエクスポート
- submitフロー自体の実装（未解決事項2で「不要」と決定）
- 過去データの遡及計算（未解決事項7）
- 監査ログ（未解決事項6）
- ページネーション（施設数が少ない前提。増大時は別issueで検討）
