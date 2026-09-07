# 不変条件カタログ（I-xxx）

業務データが「どの経路から書かれても」満たしていなければならない条件の正本（issue #757 の 3）。
[約束カタログ](./promise-catalog.md)（P-xxx）が「誰が何をできるか」（認可）を扱うのに対し、ここは
「データがどういう形でなければならないか」を扱う。守る場所は原則 DB（CHECK / UNIQUE / トリガー /
生成列）。集計をまたぐため DB 制約にできないものは夜間 SELECT 検査（#757 の 9）に回し、状態を
「計画」にしておく。

## 更新ルール

- 列は固定 7 列: ID / 不変条件 / 守る場所 / 破る操作 / 期待 / 守るテスト / 状態。列の中に `|` を書かない。
- ID は `I-` + 3 桁。区分ごとに 10 刻み（数量・金額 01x / 状態遷移 02x / 関係の個数 03x /
  派生値 04x / 集計をまたぐ 05x）。欠番は詰めない。
- 守るテスト列はバッククォートでファイルパスを書き、**そのファイルの中に ID 文字列が実在する**ことを
  `scripts/check-invariant-catalog.test.sh`（CI `hooks-test`）が検査する。テストコードにあるのに
  カタログに無い ID も違反。守るテストが無い行は `未` と書く。
- 状態は 3 語のみ: 実装済み（DB が守り、破るテストが green）/ 計画（守る場所は決めたが未実装。
  夜間検査を含む）/ 対象外（守らない理由を不変条件列に書く）。`未` の行は「計画」しか取れない。
- 新しい CHECK は `NOT VALID` で入れ、既存行の違反 0 件を夜間検査で確認してから別 migration で
  `VALIDATE CONSTRAINT` する（expand → validate）。
- アプリは判定ロジックを持たず、23514（check_violation）を `src/lib/invariant-error.ts` で
  利用者向けの一文に写像するだけ。画面の入力検証は利便性であって防御ではない。

## 数量・金額

| ID | 不変条件 | 守る場所 | 破る操作 | 期待 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| I-010 | 発注明細（症例・消耗品・短貸）の数量は 1 以上 | CHECK `*_order_items_quantity_positive`（20260906000003） | 発注 RPC に quantity 0 / -1 の明細を渡す | 23514。ヘッダも残らない（RPC は 1 トランザクション） | `supabase/__tests__/integration/business-invariants.integration.test.ts`、`supabase/migrations/__tests__/add_business_invariant_checks.test.ts` | 実装済み |
| I-011 | 返却明細の数量は 1 以上 | CHECK `loan_return_items_quantity_positive` | 返却 RPC に quantity 0 の明細を渡す | 23514 | `supabase/__tests__/integration/business-invariants.integration.test.ts`、`supabase/migrations/__tests__/add_business_invariant_checks.test.ts` | 実装済み |
| I-012 | 明細の単価スナップショットは 0 以上。NULL（金額データなし）は許す | CHECK `*_order_items_unit_price_nonnegative` | service_role で unit_price -1 を直接 INSERT | 23514。NULL は通る | `supabase/__tests__/integration/business-invariants.integration.test.ts`、`supabase/migrations/__tests__/add_business_invariant_checks.test.ts` | 実装済み |
| I-013 | 施設別価格の仕切値・納品価格は 0 以上 | CHECK `hospital_prices_prices_nonnegative` | 負の価格で INSERT / UPDATE | 23514 | `supabase/__tests__/integration/business-invariants.integration.test.ts`、`supabase/migrations/__tests__/add_business_invariant_checks.test.ts` | 実装済み |
| I-014 | 代理店商品の入数は 1 以上、償還価格は 0 以上（NULL 可） | CHECK `distributor_products_quantity_positive` / `distributor_products_reimbursement_price_nonnegative` | service_role で quantity 0 / reimbursement_price -1 を INSERT | 23514 | `supabase/__tests__/integration/business-invariants.integration.test.ts`、`supabase/migrations/__tests__/add_business_invariant_checks.test.ts` | 実装済み |
| I-015 | 納品価格は仕切値以上（粗利が負にならない）。**対象外**: 戦略的な赤字納入がありうるため制約にしない。負の粗利は夜間検査で件数だけ出す（I-051） | — | — | — | 未 | 対象外 |

## 状態遷移

| ID | 不変条件 | 守る場所 | 破る操作 | 期待 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| I-020 | 発注（3 種）と返却の状態は前にしか進まない（draft → submitted / returned）。draft 以外からは変えられない | トリガー `enforce_status_forward_only`（BEFORE UPDATE OF status、check_violation） | service_role で submitted → draft に UPDATE | 23514。status は submitted のまま | `supabase/__tests__/integration/business-invariants.integration.test.ts`、`supabase/migrations/__tests__/add_business_invariant_checks.test.ts` | 実装済み |
| I-021 | 状態の値は決められた語だけ（draft / submitted、返却は draft / returned） | CHECK（20260624000000 の `status IN (...)`） | 未知の status で INSERT | 23514 | 未 | 計画 |

## 関係の個数

| ID | 不変条件 | 守る場所 | 破る操作 | 期待 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| I-030 | 短貸発注 1 件に返却は 1 件まで（issue #675） | 部分 UNIQUE `loan_returns_loan_order_id_unique`（P-050） | 同じ loan_order_id で返却登録を 2 回・2 件同時 | 2 回目は 23505、同時送信は成功 1 / 失敗 1 | `supabase/__tests__/integration/loan-returns-rls-idor.integration.test.ts` | 実装済み |
| I-031 | 施設 × 代理店商品の価格は 1 行 | UNIQUE `hospital_prices(distributor_product_id, facility_id)`（P-052） | 同じ組み合わせを並列 INSERT | 成功 1 / 23505 1 | `supabase/__tests__/integration/hospital-prices-concurrency.integration.test.ts` | 実装済み |
| I-032 | 互換ペアは自己参照せず、順序付き（小 < 大）で 1 件 | CHECK `no_self_compat` / `ordered_pair`、UNIQUE | 同じ製品同士、逆順、重複 | 23514 / 23505 | `supabase/__tests__/integration/product-compatibilities-constraints.integration.test.ts` | 実装済み |
| I-033 | 利用者は 1 施設に 1 行（同じ施設に二重所属しない） | 主キー `user_facilities(user_id, facility_id)` | 同じ組み合わせを 2 回 INSERT | 23505 | 未 | 計画 |
| I-034 | 同じ施設 × 同じ `client_request_id` の発注（3 種）・返却は 1 行（画面の再送・二重クリックで同じ発注が 2 件できない） | 部分 UNIQUE `*_client_request_id_unique`（20260906000006、P-053）。RPC は同じ鍵で既存の行を返す | 同じ鍵で RPC を 2 回・2 件同時、service_role で同じ鍵を 2 回 INSERT | RPC は同じ id を返し行は 1 件。直接 INSERT の 2 回目は 23505 | `supabase/__tests__/integration/order-idempotency.integration.test.ts`、`supabase/migrations/__tests__/add_client_request_id_for_order_idempotency.test.ts` | 実装済み |

## 派生値

| ID | 不変条件 | 守る場所 | 破る操作 | 期待 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| I-040 | 粗利 = 納品価格 − 仕切値。掛け率 = 価格 ÷ 償還価格で、償還価格が変わると全施設の掛け率が追従し、償還価格が NULL / 0 なら掛け率は NULL | 生成列 `gross_profit`、トリガー `compute_hospital_price_rates` / `propagate_reimbursement_price_change` | 価格を UPDATE、償還価格を UPDATE / NULL 化 | 直後の SELECT で等式が成り立つ | `supabase/__tests__/integration/business-invariants.integration.test.ts` | 実装済み |
| I-041 | 価格履歴は値が変わったときだけ 1 件増え、直接 INSERT できない | SECURITY DEFINER トリガー、RLS `price_histories_no_insert`（P-051） | 同値 UPDATE、直接 INSERT | 増えない、拒否 | `supabase/__tests__/integration/price-histories-rls-idor.integration.test.ts` | 実装済み |
| I-042 | `updated_at` は更新のたびに進む（楽観ロックの前提） | トリガー `update_updated_at`（P-052 が依存） | 2 回 UPDATE して比較 | 単調増加 | `supabase/__tests__/integration/hospital-prices-concurrency.integration.test.ts` | 実装済み |

## 集計をまたぐ（DB 制約にできない。夜間 SELECT 検査 #757 の 9）

| ID | 不変条件 | 守る場所 | 破る操作 | 期待 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| I-050 | 返却明細の数量合計は、対応する短貸発注の明細数量合計を JAN ごとに超えない | 夜間検査 `check_business_invariants()`（pg_cron 22:50 UTC が `record_business_invariants()` で `schema_drift_log` に記録し、`schema-drift-check.yml` が issue 化・自動クローズ。20260906000005） | 貸出 1 個に対し返却 2 個を登録 | `I-050:<loan_order_id>:<jan>` が detected で残り、返却を消すと resolved | `supabase/__tests__/integration/business-invariants-nightly.integration.test.ts`、`supabase/migrations/__tests__/add_nightly_invariant_check.test.ts` | 実装済み |
| I-051 | NOT VALID で入れた CHECK（I-01x）に違反する既存行が 0 件（pg_constraint から動的に列挙し `NOT (制約式)` で数える。制約を足しても検査側の変更は不要） | 同上の夜間検査 | 制約導入前の古い行 | 違反があれば `I-051:<制約名>` が detected。0 件なら VALIDATE CONSTRAINT へ | `supabase/__tests__/integration/business-invariants-nightly.integration.test.ts`、`supabase/migrations/__tests__/add_nightly_invariant_check.test.ts` | 実装済み |
| I-052 | 施設を削除すると、その施設の発注・返却・価格・所属が残らない | FK `ON DELETE CASCADE`（20260624000000 / 20260627010000） | 施設を DELETE して各表を数える | 0 件 | 未 | 計画 |

## 限界

- **条件が業務上正しいかは見ない。** DB がその条件を守っているかしか見ない。
  「数量は 1 以上」が本当に業務のルールかは人が決める。
- **集計をまたぐ条件は書き込みの瞬間に止められない。** 1 行の CHECK では表せないので
  夜間検査（#757 の 9）に回しており、破られてから最大 1 日は残る。
- **`NOT VALID` の CHECK は既存行を見ていない。** 新しい行は止まるが、入れた時点の
  違反行はそのまま残る。夜間検査で 0 件を確認してから `VALIDATE CONSTRAINT` するまでは穴。
- **アプリ側の入力検証は数えていない。** 画面で弾いていても DB に CHECK が無ければ
  この表では「守っていない」。逆に DB にあれば画面の有無は問わない。
