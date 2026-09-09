# 操作の契約（O-xxx）

**1 操作 = 1 行。** 「操作」は **（表 × 動詞）** のこと。
表単位で「書き手は authenticated」と決めていた頃、`GRANT ALL` の 3 文字で 4 動詞が開き、
**誰も決めていない権限が 3 か月で 20 件たまった**（2026-09-09 に実測して 0 に戻した。E-056 / E-057）。
決める単位を、実際に穴が開く単位＝操作に揃える。

## この表に書くこと・書かないこと

**機械が実態から出せる値は書かない。** 書くと必ず古くなり、読んだ人が実態と違うことを信じる
（[`check-design-pitfalls.md`](./check-design-pitfalls.md) の C-010 / C-011 で 2 回踏んでいる）。

| 種類 | 例 | どうするか |
| --- | --- | --- |
| 機械が出せる | DB の権限・ポリシー・route のメソッド・アプリの直接書き込み・テストの実在 | **書かない。** 導出して、この表と突き合わせる |
| 機械が出せない | 入口をどれに絞るか・直接書き込みを禁じるか・誰に許すか・危険度 | **ここに書く**（人の判断） |

- 「誰が何をできるか」のロール側の正本は [`role-rulebook.md`](./role-rulebook.md)（R-xxx）
- 表を作るときの 4 軸は [`table-rulebook.md`](./table-rulebook.md)（TB-xxx）。**動詞までは見ない**ので、
  動詞の粒度はこちらが正本
- 約束（誰が守るか）は [`promise-catalog.md`](./promise-catalog.md)（P-xxx）

## 更新ルール

- 列は固定 8 列: ID / 対象 / 操作 / 入口 / 直接書き込み / 認可 / 危険度 / 状態。列の中に `|` を書かない。
- ID は `O-` + 3 桁。区分ごとに 10 刻み（発注・返却のヘッダ 01x / 明細 02x / 施設スコープのデータ 03x /
  商品・カテゴリ 04x / 販売店商品・互換 05x / 施設と所属 06x）。欠番は詰めない。
- **操作**は `INSERT` / `UPDATE` / `DELETE` の 3 語のみ（読みはこの表の対象外。読みは P-010〜P-018）。
- **入口**はバッククォートで `rpc:<関数名>` か HTTP メソッド + パスを書く。複数あれば ` / ` で並べる。
  入口が無い操作は行を作らない（＝権限も無いはず、という意味になる）。
- **直接書き込み**は `許可` / `禁止` の 2 語のみ。
  - `許可` … アプリが `.from('表').<動詞>(` で直接書く。DB のクライアント権限が**要る**
  - `禁止` … 書くのは SECURITY DEFINER の RPC だけ。DB のクライアント権限が**あってはいけない**
- **危険度**は `高` / `中` / `低` の 3 語のみ。返す順と、剥がすときの優先度を決めるために使う。
  - 高 … 業務データが壊れる・戻せない（発注の作成、所属の変更）
  - 中 … 全施設に波及する（マスタ）
  - 低 … 施設内で直せる
- 状態は 3 語のみ: 実装済み / 計画 / 対象外。
- 形の検査は汎用エンジン `scripts/lib/check-catalog.mjs`（登録は `scripts/lib/catalog-registry.json`）。
  **中身の検査**（宣言と実態の突合）は `scripts/lib/check-operation-contracts.mjs` が行い、
  `scripts/check-operation-contracts.test.sh`（CI `hooks-test`）が回す。

## 新しい操作を足すときの手順

1. **この表に 1 行足す**（先に決める）。足さずに GRANT を書くと、突合で「宣言が無い」で落ちる。
2. `直接書き込み: 禁止` にしたなら、DB のクライアント権限を**与えない**。RPC を作る。
3. `許可` にしたなら、GRANT とポリシーを**その動詞だけ**に付ける（`GRANT ALL` / `FOR ALL` にしない）。
4. 入口（route か RPC）を作る。route なら攻撃表（`e2e/api-attack-matrix.ts`）にも載せる。
5. 突合の検査を回す: `node scripts/lib/check-operation-contracts.mjs`

## 一覧

| ID | 対象 | 操作 | 入口 | 直接書き込み | 認可 | 危険度 | 状態 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| O-010 | case_orders | INSERT | `rpc:create_case_order_atomic` / `POST /api/case-orders` | 禁止 | 施設 writer + aal2 | 高 | 実装済み |
| O-011 | case_orders | UPDATE | `PATCH /api/case-orders/[id]` | 許可 | 施設 writer + aal2 | 高 | 実装済み |
| O-012 | consumable_orders | INSERT | `rpc:create_consumable_order_atomic` / `POST /api/consumable-orders` | 禁止 | 施設 writer + aal2 | 高 | 実装済み |
| O-013 | consumable_orders | UPDATE | `PATCH /api/consumable-orders/[id]` | 許可 | 施設 writer + aal2 | 高 | 実装済み |
| O-014 | loan_orders | INSERT | `rpc:create_loan_order_atomic` / `POST /api/loan-orders` | 禁止 | 施設 writer + aal2 | 高 | 実装済み |
| O-015 | loan_orders | UPDATE | `PATCH /api/loan-orders/[id]` | 許可 | 施設 writer + aal2 | 高 | 実装済み |
| O-016 | loan_returns | INSERT | `rpc:create_loan_return_atomic` / `POST /api/loan-returns` | 禁止 | 施設 writer + aal2 | 高 | 実装済み |
| O-017 | loan_returns | UPDATE | `PATCH /api/loan-returns/[id]` | 許可 | 施設 writer + aal2 | 高 | 実装済み |
| O-020 | case_order_items | INSERT | `rpc:create_case_order_atomic` | 禁止 | 親の施設 writer + aal2 | 高 | 実装済み |
| O-021 | consumable_order_items | INSERT | `rpc:create_consumable_order_atomic` | 禁止 | 親の施設 writer + aal2 | 高 | 実装済み |
| O-022 | loan_order_items | INSERT | `rpc:create_loan_order_atomic` | 禁止 | 親の施設 writer + aal2 | 高 | 実装済み |
| O-023 | loan_return_items | INSERT | `rpc:create_loan_return_atomic` | 禁止 | 親の施設 writer + aal2 | 高 | 実装済み |
| O-024 | loan_return_items | UPDATE | `PATCH /api/loan-returns/[id]/items/[itemId]` | 許可 | 親の施設 writer + aal2 | 高 | 実装済み |
| O-030 | consumables | INSERT | `POST /api/consumables` | 許可 | 施設 writer + aal2 | 低 | 実装済み |
| O-031 | consumables | UPDATE | `PUT /api/consumables/[id]` / `PATCH /api/consumables/[id]` | 許可 | 施設 writer + aal2 | 低 | 実装済み |
| O-032 | consumables | DELETE | `DELETE /api/consumables/[id]` | 許可 | 施設 writer + aal2 | 低 | 実装済み |
| O-033 | hospital_prices | INSERT | `POST /api/hospital-prices` | 許可 | 施設 writer + aal2 | 中 | 実装済み |
| O-034 | hospital_prices | UPDATE | `PUT /api/hospital-prices/[id]` | 許可 | 施設 writer + aal2 | 中 | 実装済み |
| O-035 | hospital_prices | DELETE | `DELETE /api/hospital-prices/[id]` | 許可 | 施設 writer + aal2 | 中 | 実装済み |
| O-040 | products | INSERT | `POST /api/products` | 許可 | admin + aal2 | 中 | 実装済み |
| O-041 | products | UPDATE | `PUT /api/products/[id]` | 許可 | admin + aal2 | 中 | 実装済み |
| O-042 | products | DELETE | `DELETE /api/products/[id]` | 許可 | admin + aal2 | 中 | 実装済み |
| O-043 | categories | INSERT | `POST /api/categories` | 許可 | admin + aal2 | 中 | 実装済み |
| O-044 | categories | UPDATE | `PUT /api/categories/[id]` | 許可 | admin + aal2 | 中 | 実装済み |
| O-045 | categories | DELETE | `DELETE /api/categories/[id]` | 許可 | admin + aal2 | 中 | 実装済み |
| O-050 | distributor_products | INSERT | `POST /api/distributor-products` | 許可 | admin + aal2 | 中 | 実装済み |
| O-051 | distributor_products | UPDATE | `PUT /api/distributor-products/[id]` | 許可 | admin + aal2 | 中 | 実装済み |
| O-052 | distributor_products | DELETE | `DELETE /api/distributor-products/[id]` | 許可 | admin + aal2 | 中 | 実装済み |
| O-053 | product_compatibilities | INSERT | `POST /api/compat` | 許可 | admin + aal2 | 中 | 実装済み |
| O-054 | product_compatibilities | DELETE | `DELETE /api/compat/[id]` | 許可 | admin + aal2 | 中 | 実装済み |
| O-060 | facilities | INSERT | `POST /api/facilities` | 許可 | admin + aal2 | 高 | 実装済み |
| O-061 | facilities | UPDATE | `PUT /api/facilities/[id]` | 許可 | 施設 writer | 中 | 実装済み |
| O-062 | user_facilities | INSERT | `POST /api/admin/user-facilities` | 許可 | admin + aal2 | 高 | 実装済み |
| O-063 | user_facilities | UPDATE | `POST /api/admin/user-facilities` | 許可 | admin + aal2 | 高 | 実装済み |
| O-064 | user_facilities | DELETE | `DELETE /api/admin/user-facilities` | 許可 | admin + aal2 | 高 | 実装済み |

## 読み方

- **`直接書き込み: 禁止` の行がこの表の主役。** RPC だけを入口にすると、RPC が守っている約束
  （単価スナップショット・作成＝確定・ヘッダと明細の一括性）を飛ばして行を作れなくなる。
  クライアントの権限が 1 つでも戻ると突合で落ちる。
- **DELETE の行が少ない**のは、間違えた発注・返却は削除ではなく**取り消し状態**にすると決めたから
  （E-056）。削除の行が無い表は、DB にも DELETE 権限が無い。
- `user_facilities` の INSERT と UPDATE が同じ入口なのは、upsert（`ON CONFLICT DO UPDATE`）で
  1 回の呼び出しが 2 つの権限を要求するため。

## 限界

- **入口が「呼ばれているか」は見ない。** route が実在し、そのメソッドを export していることまで。
  route の中で認可を呼んでいるかは `check-rate-limit-coverage` / 攻撃表（P-017）の担当で、
  **その認可判定が正しいかは RLS の変異計測**（`scripts/check-rls-mutation.sh`）まで行かないと分からない。
- **認可の列は突き合わせていない。** 「施設 writer + aal2」と書いてあるかどうかと、
  実際のポリシー本文が一致するかは見ていない（本文の一致は
  `check-guard-regressions` が「関数名が消えていないか」だけ見る）。**ここが今いちばん弱い**。
- **危険度は人が決める。** 高い順に返す運用に使うだけで、機械は語彙しか見ない。
- 読み取り（SELECT）の操作は載せていない。読みの境界は P-010〜P-018 と表の掃きが受け持つ。
- `service_role` からの書き込みはこの表の対象外（[`privileged-write-rulebook.md`](./privileged-write-rulebook.md) の W-xxx）。
