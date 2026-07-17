# 機能仕様書 — issue #458 / #459: admin価格履歴閲覧漏れ・unit_price未配線バグの修正

> ステータス: **レビュー待ち（停止①）**
> 作成日: 2026-07-18
> 由来: プロダクトコード実バグ調査（Explore agentによる横断調査、原因調査は完了済み）。
> TRI/RISK機械判定によりM/Lレーン対象（supabase/migrations・facility/inventory領域に該当）。
> 原因調査（Phase 1 Sweep相当）は既に完了しているため省略するが、レビューゲート（停止①・②）
> とRLS/facility境界の攻撃者視点テストは省略しない方針で進める（`docs/agents/decisions.md`
> 「なぜTRI/RISK判定を機械判定にし人の裁量で緩めないことにしたか」を踏まえた判断）。

---

## Part 1 — 仕様（★人間がレビューする部分）

### 対象issue

- [#458](https://github.com/huuriekaiseki-sketch/medical-inventory-vkumai/issues/458) get_distributor_product_price_history RPCがadminの全施設閲覧権限を無視している
- [#459](https://github.com/huuriekaiseki-sketch/medical-inventory-vkumai/issues/459) unit_priceカラムがcase/consumable/loan-ordersのアプリ層(型・リポジトリ)で無視されている

無関係な2つのバグだが、同じ調査セッションで見つかったためSPECはまとめて作成する。**実装・PRは別ブランチに分ける**（1つのPRに無関係なissueのコミットが混ざらないようにする、`docs/agents/common.md`「ブランチ運用ルール」）。

---

### issue #458: admin価格履歴閲覧漏れ

#### 背景・課題

`get_distributor_product_price_history` RPC（`supabase/migrations/20260627010000_add_multitenant.sql:155-191`）は `SECURITY DEFINER` でRLSをバイパスするため、施設アクセス制御を関数内のWHERE句で自前実装している。hospital_price側のブランチ（179-190行目）は `AND is_facility_member(hp.facility_id)` のみでフィルタしており、`OR is_admin()` が無い。

`is_admin()` 関数自体は翌日の `20260628010000_add_role_to_user_facilities.sql` で新設され、`20260628010001_update_rls_admin.sql` で `hospital_prices` 本体を含む全RLSポリシーに `OR is_admin()` が追加された。しかしこのRPCはRLSポリシーではなくSECURITY DEFINER関数内の手書きWHERE句のため、その一斉更新の対象から漏れた（コードを確認し原因を特定済み）。

#### 何が変わるか

admin権限を持つユーザーが、自分が`user_facilities`に所属していない施設の病院別価格変更履歴も閲覧できるようになる（他の画面・RPCと同じadmin権限の扱いに揃える）。

#### 今回やらないこと

- `is_admin()`より前の設計だった他の関数・ポリシーへの遡及的な監査（横断確認はやることに含めるが、見つかった場合は別issueとして切り出す。今回のスコープは本RPCの修正のみ）
- UI側の変更（既存のadmin向け全施設アクセスUIをそのまま利用できる想定。もし専用のUI導線が無ければ別途確認）

#### 受け入れ条件（チェックリスト）

- [ ] `is_admin()` が真のユーザーが、`user_facilities`に自分の割当が無い施設の`distributor_product`の価格履歴を取得すると、その施設のhospital_price変更履歴が結果に含まれる
- [ ] `is_admin()` が偽（一般ユーザー）で、かつ対象施設の`user_facilities`に割当が無いユーザーが同じRPCを呼ぶと、**その施設のhospital_price変更履歴は結果に含まれない**（他テナントIDでアクセスし、正しく弾かれることを確認する。issue #24再発防止チェック）
- [ ] 一般ユーザーが自分の所属施設のhospital_price変更履歴を取得すると、従来どおり結果に含まれる（既存の正常系が壊れていないことの回帰確認）
- [ ] `distributor_product`側のブランチ（施設に依存しない全体価格履歴、174-176行目）は今回変更しない（挙動が変わらないことを確認）

---

### issue #459: unit_priceカラムのアプリ層未配線

#### 背景・課題

`supabase/migrations/20260715000001_add_unit_price_to_order_items.sql` で `case_order_items`/`consumable_order_items`/`loan_order_items` に `unit_price NUMERIC(12,2)`（発注時点の単価スナップショット、既存行はNULL）が追加され、発注作成時のRPC（`20260715000002_add_unit_price_snapshot_to_order_rpcs.sql`）で算出・INSERTされている。

しかし `src/lib/case-orders/repository.ts`・`src/lib/consumable-orders/repository.ts`・`src/lib/loan-orders/repository.ts` の `*ItemRow` インターフェースと `mapItem()`、および `src/types/order.ts` の `CaseOrderItem`/`ConsumableOrderItem`/`LoanOrderItem` のいずれにも `unit_price`/`unitPrice` が無く、DBから取得しても静かに破棄されている（コードを確認し原因を特定済み）。

#### 何が変わるか

`listCaseOrders`/`listConsumableOrders`/`listLoanOrders` 等が返す各注文明細の型に `unitPrice: number | null` が追加され、実際にDBの値がマッピングされるようになる。既存データはNULLのままなので `null` を許容する。

#### 今回やらないこと

- UI側で単価を実際に表示する機能の追加（今回は「型・データ層に正しく配線する」までがスコープ。表示するかどうかは別issue・別画面の話）
- `unit_price` を使った金額再計算ロジックの変更（既存の `get_order_amount_report` RPC経由の集計は今回変更しない）

#### 受け入れ条件（チェックリスト）

- [ ] `CaseOrderItem`/`ConsumableOrderItem`/`LoanOrderItem`（`src/types/order.ts`）に `unitPrice: number | null` が追加される
- [ ] 3つの `repository.ts` の `*ItemRow` インターフェースに `unit_price?: unknown` が追加され、`mapItem()` が `unitPrice: asNullableNumber(row.unit_price)` を返す
- [ ] `unit_price` がNULLの行（既存データ）でも `mapItem()` がエラーにならず `unitPrice: null` を返す
- [ ] `unit_price` に数値が入っている行で、`mapItem()` が正しい数値型（文字列のままではなく`number`）で返す（PostgreSQLのNUMERIC型はJSでは文字列として返ってくることがあるため、`asNullableNumber`による変換が効いていることを確認）
- [ ] 既存の `npm test` が全てパスし続ける（既存のテストで`unitPrice`未定義を前提にしていた箇所があれば型エラーで検出される）

---

### 判断が必要な点（レビュー時に確認・レビュー済み）

1. **#458の修正はマイグレーション（`CREATE OR REPLACE FUNCTION`）で行うが、これは新しいテーブル追加・削除ではないため `refresh_schema_baseline_snapshot` は不要という理解でよいか**（`20260715000001`のWHYコメントと同じ判断）→ **承認**。CREATE OR REPLACE FUNCTIONはテーブルに一切触れないため対象外。
2. **#459で追加するのは型とマッピングのみで、UIには一切手を入れない**という今回のスコープでよいか → **承認**。`src/app`/`src/components`配下でCaseOrderItem等の型を直接importしている箇所は無く、UI層は構造的に依存していないため安全な追加的変更。
3. **#458の横断確認（他にも`is_admin()`導入前の同種の漏れが無いか）を今回のPRに含めるか、見つかった場合のみ別issueにするか** → **調査のみ実施、実装はこのPRに含めない**方針で承認。

#### 横断確認の結果（2026-07-18実施）

`is_admin()`導入（`20260628010000_add_role_to_user_facilities.sql`）より前に定義されたSECURITY DEFINER関数を全て洗い出した。

- `get_distributor_product_price_history`（本issue #458で修正対象）以外に、**read-access（閲覧系）のSECURITY DEFINER関数で同種の漏れは見つからなかった**（トリガー関数`trg_distributor_products_price_history`/`trg_hospital_prices_price_history`は施設チェック自体を持たないため対象外）
- `create_case_order_atomic`/`create_loan_order_atomic`/`create_consumable_order_atomic`（発注作成RPC）は`is_facility_member`のみで`is_admin()`が無いが、最新版（`20260715000002_add_unit_price_snapshot_to_order_rpcs.sql`）まで一貫してこの形であり、「更新漏れ」ではなく「adminでも所属施設以外への発注作成は意図的に不可」という設計の可能性が高い（write-pathの権限設計は#458のread-pathの話とは別カテゴリ）。**#458と同じバグパターンではないため今回のPRには含めない**。admin全施設モードの要否自体は別途の設計判断が必要であれば改めてissue化する。

---

## Part 2 — 実装計画（AI用・技術詳細・レビュー不要）

### issue #458

- 新規マイグレーション（例: `supabase/migrations/20260718000001_fix_price_history_admin_access.sql`）を作成
- `CREATE OR REPLACE FUNCTION get_distributor_product_price_history(...)` で関数全体を再定義し、hospital_price側ブランチのWHERE句を `AND (is_facility_member(hp.facility_id) OR is_admin())` に変更する（`SECURITY DEFINER SET search_path = public` 等の既存属性は維持）
- ローカルSupabase（`supabase db reset`後）で以下を実測確認する:
  - admin・非member施設のRPC呼び出しで履歴が見えること
  - 非admin・非member施設のRPC呼び出しで履歴が見えないこと（弾かれることの確認）
  - 既存member施設のRPC呼び出しが従来通り動作すること
- `docs/agents/known-failure-patterns.md`に該当する再発防止パターンがあれば追記を検討する

### issue #459

- `src/types/order.ts`: `CaseOrderItem`/`ConsumableOrderItem`/`LoanOrderItem` それぞれに `unitPrice: number | null` を追加
- `src/lib/case-orders/repository.ts`: `CaseOrderItemRow` に `unit_price?: unknown` 追加、`mapItem()` に `unitPrice: asNullableNumber(row.unit_price)` 追加
- `src/lib/consumable-orders/repository.ts`: 同様に `ConsumableOrderItemRow`/`mapItem()` を修正
- `src/lib/loan-orders/repository.ts`: 同様に `LoanOrderItemRow`/`mapItem()` を修正
- `asNullableNumber` は既に `src/lib/mapping.ts` に実装済み（追加実装不要）
- 既存の `*.test.ts`（vitest）に `unitPrice` のnull/数値ケースのアサーションを追加
- `npm run typecheck`・`npm test`・`npm run lint` を実行し全て通ることを確認
