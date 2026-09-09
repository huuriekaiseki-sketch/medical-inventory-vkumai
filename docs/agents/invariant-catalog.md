# 不変条件カタログ（I-xxx）

業務データが「どの経路から書かれても」満たしていなければならない条件の正本（issue #757 の 3）。
[約束カタログ](./promise-catalog.md)（P-xxx）が「誰が何をできるか」（認可）を扱うのに対し、ここは
「データがどういう形でなければならないか」を扱う。守る場所は原則 DB（CHECK / UNIQUE / トリガー /
生成列）。集計をまたぐため DB 制約にできないものは夜間 SELECT 検査（#757 の 9）に回し、状態を
「計画」にしておく。

## 更新ルール

- 列は固定 7 列: ID / 不変条件 / 守る場所 / 破る操作 / 期待 / 守るテスト / 状態。列の中に `|` を書かない。
- ID は `I-` + 3 桁。区分ごとに 10 刻み（数量・金額 01x / 状態遷移 02x / 関係の個数 03x /
  派生値 04x / 集計をまたぐ 05x / 入力の長さ 06x）。欠番は詰めない。
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
| I-010 | 発注明細（症例・消耗品・短貸）の数量は 1 以上 | CHECK `*_order_items_quantity_positive`（20260906000003） | 発注 RPC に quantity 0 / -1 の明細を渡す | 23514。ヘッダも残らない（RPC は 1 トランザクション） | `supabase/__tests__/integration/business-invariants.integration.test.ts`、`supabase/migrations/__tests__/add_business_invariant_checks.test.ts`。NUMERIC / INTEGER の境界は `supabase/__tests__/integration/invariant-properties.integration.test.ts` | 実装済み |
| I-011 | 返却明細の数量は 1 以上 | CHECK `loan_return_items_quantity_positive` | 返却 RPC に quantity 0 の明細を渡す | 23514 | `supabase/__tests__/integration/business-invariants.integration.test.ts`、`supabase/migrations/__tests__/add_business_invariant_checks.test.ts` | 実装済み |
| I-012 | 明細の単価スナップショットは 0 以上。NULL（金額データなし）は許す | CHECK `*_order_items_unit_price_nonnegative` | service_role で unit_price -1 を直接 INSERT | 23514。NULL は通る | `supabase/__tests__/integration/business-invariants.integration.test.ts`、`supabase/migrations/__tests__/add_business_invariant_checks.test.ts`。格納後の値と丸めの境界は `supabase/__tests__/integration/invariant-properties.integration.test.ts` | 実装済み |
| I-013 | 施設別価格の仕切値・納品価格は 0 以上 | CHECK `hospital_prices_prices_nonnegative` | 負の価格で INSERT / UPDATE | 23514 | `supabase/__tests__/integration/business-invariants.integration.test.ts`、`supabase/migrations/__tests__/add_business_invariant_checks.test.ts` | 実装済み |
| I-014 | 代理店商品の入数は 1 以上、償還価格は 0 以上（NULL 可） | CHECK `distributor_products_quantity_positive` / `distributor_products_reimbursement_price_nonnegative` | service_role で quantity 0 / reimbursement_price -1 を INSERT | 23514 | `supabase/__tests__/integration/business-invariants.integration.test.ts`、`supabase/migrations/__tests__/add_business_invariant_checks.test.ts` | 実装済み |
| I-015 | 納品価格は仕切値以上（粗利が負にならない）。**対象外**: 戦略的な赤字納入がありうるため制約にしない。負の粗利は夜間検査で件数だけ出す（I-051） | — | — | — | 未 | 対象外 |

## 状態遷移

| ID | 不変条件 | 守る場所 | 破る操作 | 期待 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| I-020 | 状態は前にしか進まない（draft → submitted / returned）。draft 以外からは変えられない。**終端（cancelled / retired）へはいつでも進めるが、終端からは戻れない**（2026-09-08・E-056 で cancelled、2026-09-09 で retired。対象は発注 3 種・返却・返却明細・消耗品の 6 表） | トリガー `enforce_status_forward_only`（BEFORE UPDATE OF status、check_violation） | service_role で submitted → draft に UPDATE | 23514。status は submitted のまま | `supabase/__tests__/integration/business-invariants.integration.test.ts`、`supabase/migrations/__tests__/add_business_invariant_checks.test.ts`、`supabase/migrations/__tests__/allow_retiring_consumables.test.ts`。順番の組み合わせは `supabase/__tests__/integration/invariant-properties.integration.test.ts` | 実装済み |
| I-021 | 状態の値は決められた語だけ（発注 3 種は draft / submitted / cancelled、返却は draft / returned / cancelled、返却明細は active / cancelled、消耗品は active / retired） | CHECK（20260624000000 の `status IN (...)`、返却明細は 20260909000000、消耗品は 20260909010000） | 未知の status へ UPDATE する | 23514。決めてある値へは進める（対照） | `supabase/__tests__/integration/business-invariants.integration.test.ts`（消耗品発注と消耗品で実測。他の 4 表は同じ形の CHECK で未実測） | 実装済み |
| I-022 | **返却が残っている短貸発注は取り消せない**（2026-09-09、人の業務判断）。物が動いた事実がある発注を「無かったこと」にはできないので、先に返却を取り消す。「生きた返却」は残数の数え方と揃え、header の紐付けと明細の紐付けの**どちらか**で数える。**逆向き（取り消し済みの発注へあとから返却を作る）は許す**（同じ判断の場で決定。これは遷移の条件であって「取り消し済みには返却が無い」という不変条件ではない） | トリガー `enforce_loan_order_cancellable`（BEFORE UPDATE OF status ON loan_orders、20260909050000、check_violation） | 返却を作ってから発注を cancelled へ UPDATE する | 23514（`has active returns`）。status は submitted のまま。返却を取り消せば通る（対照） | `supabase/__tests__/integration/loan-order-cancel-boundary.integration.test.ts`、`src/lib/orders/__tests__/cancel.test.ts`（利用者向けの文言への写し）。効き目は `scripts/lib/rls-mutants.json` の RM-015 が実測する | 実装済み |

## 関係の個数

| ID | 不変条件 | 守る場所 | 破る操作 | 期待 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| I-030 | 短貸発注は分割して返せるが、**明細ごとに返却の合計が借りた数量を超えない**（2026-09-08 に「1 発注 : 1 返却」から変えた。分割して返す運用が実在するため。E-054）。**取り消した返却（status=cancelled）は数えない**（E-056。数えると取り消しても返し直せない） | トリガー `enforce_loan_return_not_over`（BEFORE INSERT OR UPDATE、20260908030000。発注明細を FOR UPDATE で掴んでから合計を数えるので同時送信でも超えない。P-050） | 合計が借りた数を超える返却明細を作る（1 回で超える／分割して合計で超える／全量を 2 件同時送信） | 23514。ちょうど借りた数までは通る（対照）。同時送信は成功 1 / 失敗 1 | `supabase/__tests__/integration/partial-loan-returns.integration.test.ts`、`supabase/__tests__/integration/loan-returns-rls-idor.integration.test.ts` | 実装済み |
| I-031 | 施設 × 代理店商品の価格は 1 行 | UNIQUE `hospital_prices(distributor_product_id, facility_id)`（P-052） | 同じ組み合わせを並列 INSERT | 成功 1 / 23505 1 | `supabase/__tests__/integration/hospital-prices-concurrency.integration.test.ts` | 実装済み |
| I-032 | 互換ペアは自己参照せず、順序付き（小 < 大）で 1 件 | CHECK `no_self_compat` / `ordered_pair`、UNIQUE | 同じ製品同士、逆順、重複 | 23514 / 23505 | `supabase/__tests__/integration/product-compatibilities-constraints.integration.test.ts` | 実装済み |
| I-033 | 利用者は 1 施設に 1 行（同じ施設に二重所属しない）。**役割を変えても 2 行目は入らない**（主キーに role が入っていないため。viewer と admin を同時に持てない） | 主キー `user_facilities(user_id, facility_id)` | 同じ組み合わせを 2 回 INSERT（同じ役割・違う役割の両方） | 23505。別の施設へは入る（対照） | `supabase/__tests__/integration/business-invariants.integration.test.ts` | 実装済み |
| I-034 | 同じ施設 × 同じ `client_request_id` の発注（3 種）・返却は 1 行（画面の再送・二重クリックで同じ発注が 2 件できない） | 部分 UNIQUE `*_client_request_id_unique`（20260906000006、P-053）。RPC は同じ鍵で既存の行を返す | 同じ鍵で RPC を 2 回・2 件同時、service_role で同じ鍵を 2 回 INSERT | RPC は同じ id を返し行は 1 件。直接 INSERT の 2 回目は 23505 | `supabase/__tests__/integration/order-idempotency.integration.test.ts`、`supabase/migrations/__tests__/add_client_request_id_for_order_idempotency.test.ts` | 実装済み |
| I-035 | 消耗品発注の明細は、**自施設の**、**使用停止でない**消耗品だけを指す（2026-09-09 の実測で、他施設の消耗品も使用停止の消耗品も指せることが分かった。**混乱した代理人**: 呼び出し元は正しく認可されていて、渡された参照先だけが他人のもの）。**過去の明細は使用停止にしても残る**（履歴は履歴のまま） | RPC `create_consumable_order_atomic` 内の検証（20260909060000、check_violation）。短貸返却（20260908040000）が持っていた同じ形を揃えたもの | 他施設の消耗品 ID・使用停止した消耗品 ID・存在しない ID で発注 RPC を呼ぶ | 23514（`is not orderable`）。自施設の生きた消耗品なら通る（対照）。明細が 1 つでも悪ければ発注ごと残らない | `supabase/__tests__/integration/consumable-order-items-boundary.integration.test.ts`、`src/lib/consumable-orders/__tests__/repository.test.ts`（利用者向けの文言への写し）。効き目は `scripts/lib/rls-mutants.json` の RM-016 が実測する | 実装済み |
| I-036 | 返却の紐付け先は、**header の発注 ID も明細の発注明細 ID も**自施設のものだけ（2026-09-09 の実測で、**明細を 1 つも紐付けなければ header の発注 ID が素通りする**ことが分かった。明細側の検証は 20260908040000 で入っていたが、明細が 0 件だと WHERE に 1 行も入らない） | RPC `create_loan_return_atomic` 内の検証（header は 20260909070000、明細は 20260908040000。どちらも foreign_key_violation） | 他施設の発注 ID を header に入れ、明細を紐付けずに返却 RPC を呼ぶ | 23503。自施設の発注なら通る（対照）。明細に他施設の ID を入れた場合も 23503 | `supabase/__tests__/integration/rpc-reference-boundary.integration.test.ts`。効き目は `scripts/lib/rls-mutants.json` の RM-017 が実測する | 実装済み |

## 派生値

| ID | 不変条件 | 守る場所 | 破る操作 | 期待 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| I-040 | 粗利 = 納品価格 − 仕切値。掛け率 = 価格 ÷ 償還価格で、償還価格が変わると全施設の掛け率が追従し、償還価格が NULL / 0 なら掛け率は NULL | 生成列 `gross_profit`、トリガー `compute_hospital_price_rates` / `propagate_reimbursement_price_change` | 価格を UPDATE、償還価格を UPDATE / NULL 化（service_role と、所属しない施設を持つ実ユーザー admin の両方から） | 直後の SELECT で等式が成り立つ | `supabase/__tests__/integration/business-invariants.integration.test.ts` | 実装済み |
| I-041 | 価格履歴は値が変わったときだけ 1 件増え、直接 INSERT できない | SECURITY DEFINER トリガー、RLS `price_histories_no_insert`（P-051） | 同値 UPDATE、直接 INSERT | 増えない、拒否 | `supabase/__tests__/integration/price-histories-rls-idor.integration.test.ts` | 実装済み |
| I-042 | `updated_at` は更新のたびに進む（楽観ロックの前提） | トリガー `update_updated_at`（P-052 が依存） | 2 回 UPDATE して比較 | 単調増加 | `supabase/__tests__/integration/hospital-prices-concurrency.integration.test.ts` | 実装済み |

## 入力の長さ

自由入力の TEXT 列に上限を置く。画面の maxlength は利便性であって防御ではない（API を直接叩けば通る）。
2026-09-07 の実測では、上限が無かったため術式名に 1 MB の文字列がそのまま保存されていた。
値は実データの最大長の 10 倍以上にしてあり、入力欄を狭めるためのものではない。

| ID | 不変条件 | 守る場所 | 破る操作 | 期待 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| I-060 | 症例発注の術式名は 200 文字以内、患者 ID は 100 文字以内、イニシャルは 20 文字以内、医師名は 100 文字以内 | CHECK `case_orders_text_length`（20260907000004、NOT VALID） | 1 MB の術式名で発注を作る | 23514。ヘッダも明細も残らない | `supabase/__tests__/integration/text-length-limits.integration.test.ts`、`supabase/migrations/__tests__/add_text_length_limits.test.ts` | 実装済み |
| I-061 | 短貸発注の術式名とメーカー名は 200 文字以内 | CHECK `loan_orders_text_length` | 長いメーカー名で発注を作る | 23514 | `supabase/__tests__/integration/text-length-limits.integration.test.ts` | 実装済み |
| I-062 | 明細の JAN は 64 文字以内、ロットと使用期限は 100 文字以内、品名は 200 文字以内。**列は表ごとに違う**（`loan_order_items` は lot / ubd を持たず jan と name だけ） | CHECK `case_order_items_text_length` / `loan_order_items_text_length` / `loan_return_items_text_length` | 各表へ上限 +1 文字を直接 INSERT する（境界ちょうども見る） | 23514。境界ちょうどは通る | `supabase/__tests__/integration/text-length-limits.integration.test.ts`（case）、`supabase/__tests__/integration/business-invariants.integration.test.ts`（loan 発注・返却。2026-09-08 まで case の 1 表しか測っていなかった） | 実装済み |
| I-063 | 消耗品の品名は 200 文字以内、用途は 1,000 文字以内 | CHECK `consumables_text_length` | 長い用途で消耗品を作る | 23514 | `supabase/__tests__/integration/text-length-limits.integration.test.ts` | 実装済み |
| I-064 | 施設名は 200 文字以内 | CHECK `facilities_text_length` | 200,000 文字の施設名を作る | 23514 | `supabase/__tests__/integration/text-length-limits.integration.test.ts` | 実装済み |
| I-065 | マスタの JAN と品番は 64 文字以内、名称・メーカー・仕入先は 200 文字以内 | CHECK `products_text_length` / `categories_text_length` / `distributor_products_text_length` | 5,000 文字の JAN で商品を作る | 23514 | `supabase/__tests__/integration/text-length-limits.integration.test.ts` | 実装済み |
| I-066 | 既存行が上の上限を破っていない（NOT VALID で入れたので夜間検査で確かめてから VALIDATE する） | 夜間検査 I-051（pg_constraint から NOT VALID を動的に列挙。本番で 0 件を確認したら VALIDATE の migration を出す） | — | 違反 0 件 | 未 | 計画 |
| I-067 | カテゴリの説明と互換の備考は 1,000 文字以内、拒否の記録の経路は 200 文字以内 | CHECK `categories_description_length` / `product_compatibilities_note_length` / `access_denials_route_length`（20260907000007、NOT VALID） | 1,001 文字の説明でカテゴリを作る。201 文字の経路で拒否を記録する | 23514。ちょうど 1,000 文字と null は通る | `supabase/__tests__/integration/remaining-text-length-limits.integration.test.ts` | 実装済み |

## 集計をまたぐ（DB 制約にできない。夜間 SELECT 検査 #757 の 9）

| ID | 不変条件 | 守る場所 | 破る操作 | 期待 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| I-050 | 返却明細の数量合計は、対応する短貸発注の明細数量合計を JAN ごとに超えない | 夜間検査 `check_business_invariants()`（pg_cron 22:50 UTC が `record_business_invariants()` で `schema_drift_log` に記録し、`schema-drift-check.yml` が issue 化・自動クローズ。20260906000005） | 貸出 1 個に対し返却 2 個を登録 | `I-050:<loan_order_id>:<jan>` が detected で残り、返却を消すと resolved | `supabase/__tests__/integration/business-invariants-nightly.integration.test.ts`、`supabase/migrations/__tests__/add_nightly_invariant_check.test.ts` | 実装済み |
| I-051 | NOT VALID で入れた CHECK（I-01x）に違反する既存行が 0 件（pg_constraint から動的に列挙し `NOT (制約式)` で数える。制約を足しても検査側の変更は不要） | 同上の夜間検査 | 制約導入前の古い行 | 違反があれば `I-051:<制約名>` が detected。0 件なら VALIDATE CONSTRAINT へ | `supabase/__tests__/integration/business-invariants-nightly.integration.test.ts`、`supabase/migrations/__tests__/add_nightly_invariant_check.test.ts` | 実装済み |
| I-052 | 施設を削除すると、その施設の所属・発注 3 種・明細・返却・消耗品・価格・価格履歴が残らない。監査ログ（`audit_log`）は FK を張らず意図的に残す（削除の証跡）。マスタと マスタの価格履歴は消えない | FK `ON DELETE CASCADE`（20260624000000 / 20260627010000 / 20260618063046）、`price_histories` は FK が無いためトリガー `hospital_prices_delete_price_histories`（20260906000007） | service_role で施設を DELETE して各表を数える（**service_role でしか測っていない**。`facilities` に DELETE のポリシーが無く、アプリの経路では admin でも 0 行になるため。E-055） | 施設スコープの 12 表が 0 件。audit_log に facilities / case_orders の DELETE が残る | `supabase/__tests__/integration/facility-delete-cascade.integration.test.ts`、`supabase/migrations/__tests__/delete_price_histories_with_hospital_price.test.ts` | 実装済み |

## CHECK 制約の棚卸し（2026-09-08）

**「カタログに載っている」と「実 DB で測っている」は別。** 実 DB の CHECK を全部並べて、
1 件ずつ「破る操作を試しているテストがあるか」を当たった。

| | 件数 |
| --- | --- |
| 実 DB の CHECK 制約 | **47** |
| 破る操作を測っているテストがある | 40 |
| **書けないので測れない**（GRANT が手前で拒否する） | 7 |
| 測っていなかった（この日に追加した） | **5** |

**測っていなかった 5 件**（どれも「同じ不変条件を表ごとに宣言して、1 表しか測っていない」形）:

- `consumable_order_items_unit_price_nonnegative` … I-012 は全明細表を指しているのに、
  測っていたのは `loan_order_items` だけだった
- `loan_return_items_text_length` … 発注明細側は測っていたが返却明細だけ抜けていた
- `consumable_orders_status_check` … 状態の**語彙**（I-020 の「前にしか進まない」とは別の約束。
  カタログでは I-021 として「計画」のまま残っていた）
- `loan_order_items_text_length` … I-062 は 3 つの CHECK を 1 行で宣言しているが、
  測っていたのは `case_order_items` だけだった（残り 2 表をこの日に追加）

**書けないので測れない 7 件**（`audit_log` 1 / `price_histories` 2 / `schema_drift_log` 2 /
`rate_limit_counters` 2）: service_role でも INSERT が 42501 で拒否される（2026-09-08 に実測）。
CHECK の手前に GRANT というより強い扉があるので、アプリ側からは到達できない。
**これは穴ではなく、二重の防御が効いている状態**。トリガーや SECURITY DEFINER 関数を
経由した書き込みは、それぞれの表の統合テストが別に見ている。

**この棚卸しの当たり方の限界**: 最初は「その表を触るテストが 23514 を期待しているか」で機械的に
数えたが、**RPC 経由で破るテストを 1 つも拾えず 2 件を誤って「無防備」と数えた**
（`create_consumable_order_atomic` に quantity 0 を渡す形）。機械の当たりだけで結論を出さず、
1 件ずつ中身を読んで確かめている。次に同じ棚卸しをするときも同じ手当てが要る。

## 限界

- **条件が業務上正しいかは見ない。** DB がその条件を守っているかしか見ない。
  「数量は 1 以上」が本当に業務のルールかは人が決める。
- **集計をまたぐ条件は書き込みの瞬間に止められない。** 1 行の CHECK では表せないので
  夜間検査（#757 の 9）に回しており、破られてから最大 1 日は残る。
- **`NOT VALID` の CHECK は既存行を見ていない。** 新しい行は止まるが、入れた時点の
  違反行はそのまま残る。夜間検査で 0 件を確認してから `VALIDATE CONSTRAINT` するまでは穴。
- **アプリ側の入力検証は数えていない。** 画面で弾いていても DB に CHECK が無ければ
  この表では「守っていない」。逆に DB にあれば画面の有無は問わない。
- **同じ不変条件を複数の表に宣言したとき、全部を測っているとは限らない。**
  2026-09-08 の棚卸しで見つけた 3 件はすべてこの形だった（1 表だけ測って済ませていた）。
  カタログの行は `*_order_items_...` のようにワイルドカードで書けてしまうので、
  **行を読んだだけでは何表ぶん測ったか分からない**。
