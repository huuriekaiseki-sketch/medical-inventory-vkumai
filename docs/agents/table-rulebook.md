# テーブルの決めごと（TB-xxx）

新しいテーブルを作るときに決める 4 軸の正本。

2026-09-07 まで、この 4 軸は**別々の場所に散らばっていた**。RLS とポリシーは
`rls_enabled_all_tables.test.ts` の中の許可リスト、監査は `audit_trigger_coverage.test.ts` の中の
別の許可リスト、そして**「誰が読み書きできるか」はどこにも無かった**。
その結果 `schema_drift_log` は作られてから 2 か月間 GRANT が 1 行も無く、service_role でも読めず、
それを守るはずのテストが赤のまま放置されていた。

散らばっていると、新しい表を作った人が全部に書き忘れても全部が緑のままになる。
だから**決めごとはこの 1 枚に集め**、機械が「宣言」と「migration の実態」を突き合わせる。

- 認可の約束（誰が何をできるか）は [約束カタログ](./promise-catalog.md)（P-xxx）
- データの形の条件は [不変条件カタログ](./invariant-catalog.md)（I-xxx）
- **どのテストをいつ回すか**は [テスト一覧](./test-matrix.md) が正本。この表の「守るテスト」列は
  そこへの入口であって、テストの運用ルールはここには書かない（役割を分ける）

## 更新ルール

- 列は固定 8 列: ID / テーブル / ポリシー / 読み手 / 書き手 / 監査 / 守るテスト / 状態。
  列の中に `|` を書かない。
- ID は `TB-` + 3 桁。区分ごとに 10 刻み（マスタ 01x / 施設スコープの業務データ 02x /
  所属（権限）03x / 追記のみの記録 04x / 監視の裏方 05x）。欠番は詰めない。
- **読み手 / 書き手**は client ロール（`anon` / `authenticated` / `service_role`）を ` / ` で並べる。
  誰にも与えないときは `なし`。`postgres` は所有者なので書かない。
  読み手は SELECT を持つロール、書き手は INSERT / UPDATE / DELETE / TRUNCATE のどれかを持つロール。
- **ポリシー / 監査**は `あり`、またはそうしない理由を 20 文字より長く書く。「TODO」「後で」「未定」は不可。
- 状態は 3 語のみ: 実装済み / 計画 / 対象外。
- **形の検査**（列数・ID の形と重複と帯・状態の語彙・守るテストのパス実在）は
  `scripts/lib/check-catalog.mjs`（汎用エンジン）が行う。登録は `scripts/lib/catalog-registry.json`。
- **中身の検査**（宣言が migration の実態と一致するか）は
  `supabase/migrations/__tests__/table_registry.test.ts` が行う。宣言に無い表・表に無い宣言・
  値のずれの**どちらの向きでも**落ちる。`npm test` に含まれるので毎 PR 回る。
- **振る舞いの検査**（実際に他施設から読めないか）は
  `supabase/__tests__/integration/table-boundary-sweep.integration.test.ts`（P-018）が
  **この表に載っている全表**を Supabase REST で直接叩いて確かめる（2026-09-09 追加）。
  「守るテスト」列が保証しているのは**そのファイルが実在すること**だけで、
  中身がその表の境界を測っているかは形の検査では分からない。掃きはその穴を埋める。
  表を足すと掃き側に「誰から隠すのか」の定義が無くて落ちるので、**決め忘れがそこで止まる**。

## 新しいテーブルを作るときの手順

1. migration を書く。**`REVOKE ALL ON TABLE <t> FROM PUBLIC, anon, authenticated, service_role;`
   を先に書いてから**、必要な GRANT だけを書く。
   Supabase の既定権限（`ALTER DEFAULT PRIVILEGES`）が効くかは環境で変わり、実測でも効く表と
   効かない表の両方があった。**既定に答えを委ねない**。
2. この表に 1 行足す。足さないと `table_registry.test.ts` が「宣言が無い」で落ちる。
3. ポリシーを作らない表（SECURITY DEFINER 関数からしか触らない表）は、
   **実 DB で「読める人・読めない人」を測る統合テスト**も要る。静的検査は GRANT の文字列しか
   見られないため、`schema_drift_log` はこれが無くて 2 か月気づけなかった。

## マスタ

| ID | テーブル | ポリシー | 読み手 | 書き手 | 監査 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TB-010 | products | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/master-tables-admin-boundary.integration.test.ts` | 実装済み |
| TB-011 | facilities | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/master-tables-admin-boundary.integration.test.ts` | 実装済み |
| TB-012 | distributor_products | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/master-tables-admin-boundary.integration.test.ts` | 実装済み |
| TB-013 | categories | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/master-tables-admin-boundary.integration.test.ts` | 実装済み |
| TB-014 | product_compatibilities | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/product-compatibilities-constraints.integration.test.ts` | 実装済み |

## 施設スコープの業務データ

| ID | テーブル | ポリシー | 読み手 | 書き手 | 監査 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TB-020 | hospital_prices | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/hospital-prices-rls-idor.integration.test.ts` | 実装済み |
| TB-021 | consumables | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/consumable-orders-rls-idor.integration.test.ts` | 実装済み |
| TB-022 | case_orders | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/case-orders-rls-idor.integration.test.ts` | 実装済み |
| TB-023 | case_order_items | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/order-items-rls-idor.integration.test.ts` | 実装済み |
| TB-024 | consumable_orders | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/consumable-orders-rls-idor.integration.test.ts` | 実装済み |
| TB-025 | consumable_order_items | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/order-items-rls-idor.integration.test.ts` | 実装済み |
| TB-026 | loan_orders | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/loan-orders-rls-idor.integration.test.ts` | 実装済み |
| TB-027 | loan_order_items | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/order-items-rls-idor.integration.test.ts` | 実装済み |
| TB-028 | loan_returns | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/loan-returns-rls-idor.integration.test.ts` | 実装済み |
| TB-029 | loan_return_items | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/order-items-rls-idor.integration.test.ts` | 実装済み |

## 所属（権限）

| ID | テーブル | ポリシー | 読み手 | 書き手 | 監査 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TB-030 | user_facilities | あり | authenticated / service_role | authenticated / service_role | あり | `supabase/__tests__/integration/permission-change-authz.integration.test.ts` | 実装済み |

## 追記のみの記録

| ID | テーブル | ポリシー | 読み手 | 書き手 | 監査 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TB-040 | price_histories | あり | authenticated / service_role | なし | 価格の履歴そのもの。append-only で「誰がいつ何を」を既に持っており、監査行を足すと同じ事実が二重に残る | `supabase/__tests__/integration/price-histories-rls-idor.integration.test.ts` | 実装済み |
| TB-041 | audit_log | あり | authenticated / service_role | なし | 監査ログ自身。自分への INSERT でまた自分に書くと無限に増える（append-only トリガーで UPDATE / DELETE は別途拒否している） | `supabase/__tests__/integration/audit-log-rls-idor.integration.test.ts` | 実装済み |
| TB-042 | access_denials | あり | authenticated / service_role | なし | 拒否そのものの記録。append-only で、記録は SECURITY DEFINER の record_access_denial() 経由でしか増えない | `supabase/__tests__/integration/access-denials-rls-idor.integration.test.ts` | 実装済み |
| TB-043 | privileged_operations | あり | authenticated / service_role | なし | 特権操作（Auth 管理 API）の成功・失敗の記録。監査トリガーは public スキーマにしか付かず auth.users に届かないので、この表がその代わりになる。append-only で record_privileged_operation() 経由でしか増えない。**メールを含むため読み手は aal2 の admin だけ** | `supabase/__tests__/integration/privileged-operations-rls-idor.integration.test.ts` | 実装済み |

## 監視の裏方

ポリシーを 1 つも作らない（= client ロールからは deny-all）。SECURITY DEFINER 関数からしか触らない。

| ID | テーブル | ポリシー | 読み手 | 書き手 | 監査 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TB-050 | schema_drift_log | スキーマドリフト検知の内部テーブル。record_schema_drift() 等の SECURITY DEFINER 関数からのみ書き込み、クライアントロールへ直接は公開しない | service_role | なし | 監視そのものの記録であって、業務上の変更ではない。ここが動くのは検知が走ったときだけ | `supabase/__tests__/integration/schema-drift-rpc-authz.integration.test.ts` | 実装済み |
| TB-051 | schema_baseline_snapshots | スキーマドリフト検知の内部テーブル。refresh_schema_baseline_snapshot() からのみ書き込み、クライアントロールへ直接は公開しない | service_role | なし | 同じく監視の裏方であって業務上の変更ではない。ここが変わるのはスキーマそのものを直したときだけ | `supabase/__tests__/integration/schema-drift-rpc-authz.integration.test.ts` | 実装済み |
| TB-052 | rate_limit_counters | 回数を数えるだけのカウンタ。consume_rate_limit()（SECURITY DEFINER・service_role のみ EXECUTE）からしか触らない。利用者に自分のカウンタを見せる理由も書き換えさせる理由も無い | service_role | なし | 監視の裏方であって業務上の変更ではない。数え直しは毎分起きるので監査に残すと大量のノイズになる | `supabase/__tests__/integration/rate-limit-rls-idor.integration.test.ts` | 実装済み |

## 限界

- **migration の SQL しか見ない。** 実 DB に手で当てた変更、Supabase の既定権限
  （`ALTER DEFAULT PRIVILEGES`）、ダッシュボードからの操作は見えない。
  だからこそ「既定に答えを委ねず明示的に REVOKE → GRANT」を要求している。
  実 DB とのずれはスキーマドリフト検知（#305）が別に見る。
- **宣言が業務上妥当かは見ない。** 「anon にも読ませる」と書けばそのとおり通る。
  一致だけを見ており、妥当性は人が決める。
- **ポリシーの中身は見ない。** 数だけを数えるので、ポリシーが 1 つあれば
  それが `USING (true)` でも通る。中身は約束カタログ（P-xxx）と RLS/IDOR テストの担当。
- **RLS が有効かは別の検査。** ここは 4 軸のうち 3 軸（ポリシー・権限・監査）を見る。
  RLS の有効化と `DISABLE` の不在は `rls_enabled_all_tables.test.ts` が見ている。
- **列は見ない。** どんな列があるか、長さの上限があるかはこの表の外
  （`check-text-column-limits.test.sh` と不変条件カタログ）。
- **「読み手」は表への直接アクセスだけ。同じ中身を返す RPC の公開範囲は見ていない**（2026-09-11）。
  `SECURITY DEFINER` の関数は RLS も表の GRANT も通らないので、
  **表を締めても関数が開いていれば同じデータが出る**。実際 TB-040（`price_histories`）は
  読み手を `authenticated / service_role` と宣言しており表としてはそのとおりだったが、
  `get_distributor_product_price_history` が未ログインに開いていて、
  **同じ履歴がログイン無しで読めていた**（E-013）。
  RPC の側は `rpc-boundary-sweep.integration.test.ts` の `ANON_CALLABLE` が実測で見る。
  表とRPCで**別々の場所に宣言がある**ので、片方だけ見て安心しないこと。
