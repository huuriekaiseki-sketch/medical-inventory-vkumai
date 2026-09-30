# SPEC: 明細の件数の上限を、RPC でも守る（issue #825）

- feature: `issue-825-order-items-limit`
- baseCommit: `253c1ced`
- 重要度: 中 / 影響: DB（RPC 4 本の再定義と共有関数の新設）。画面と API の動きは変わらない
- 状態: 2026-09-30 承認（決めてほしいこと 4 件は、おすすめの通り: RPC の中で数える／数字は共有関数に 1 つ／23514／service_role は塞がない）。同日に実装

## 実装の結果（2026-09-30）

| 受け入れ条件 | 状態 |
| --- | --- |
| 4 種の RPC すべてで、101 件は止まり、100 件は通る | 実 DB で確認（`order-items-limit-boundary.integration.test.ts`、4 本 × 両方向 + 0 件・NULL、11 件成功） |
| 止まったとき、ヘッダも残らない | 同上（前後の件数を比較） |
| 上限の値が設定と DB で同じで、ずれたら検査が落ちる | `scripts/check-order-items-limit-consistency.test.sh`（ずらした fixture で落ちることも確認） |
| 画面と API の動きは変わらない | 単体テスト 2,475 件・統合テスト 407 件・E2E（下の PR 本文）が緑 |
| 上限の仕組みを壊すと、変異計測が検知する | RM-021（共有関数を空にする）を単体で実測し、検知された |
| 既存のデータには触れない | migration は関数の定義だけ（表の DDL なし） |

仕様書からの変更点: なし。

---

# Part 1 — 仕様（★人間がレビューする部分）

## 何ができるようになるか

1 件の発注・返却に入れられる明細の件数（100 件。人が 2026-09-20 に決めた値）が、**どの経路から来ても**守られるようになります。

いまは、画面と API の入口だけがこの上限を見ています。API を通らずに、データベースの関数（RPC）を直接呼ぶ経路には上限が無く、何万件の明細でも通ります。文字数の上限は「入口」と「DB」の 2 枚で守っているのに、件数だけが 1 枚でした。

## いま起きうること

| 経路 | 上限 | 結果 |
| --- | --- | --- |
| 画面 → API | あり（100 件） | 101 件目で「明細は 100 件までです」と止まる |
| API を通さず RPC を直接呼ぶ（認証済みの利用者なら可能） | **無い** | 何万件でも作れる。詳細ページは明細を全件そのまま表に出すので、応答も画面も際限なく大きくなる |
| `service_role` の鍵で明細の表へ直接書く | 無い | 同上（この経路は、鍵を持つ運用者だけ） |

## 変更後

| 経路 | 上限 | 結果 |
| --- | --- | --- |
| 画面 → API | あり（変わらない） | 変わらない |
| RPC を直接呼ぶ | **あり（100 件）** | 101 件以上なら、発注・返却は作られず、エラーで止まる |
| `service_role` で直接書く | 無い（変えない） | 変わらない（下の「決めてほしいこと」1 番） |

## 受け入れ条件

- [ ] 4 種の RPC（症例発注・短貸発注・消耗品発注・短貸返却）すべてで、明細 101 件は止まり、**100 件は通る**（両方向）
- [ ] 止まったとき、ヘッダも残らない（部分的に作られない）
- [ ] 上限の値は、設定（`aidd.config.json` の `limits.orderItemsMax`）と DB 側で同じ。**ずれたら検査が落ちる**
- [ ] 画面と API の動きは変わらない（既存の E2E・単体テストが緑のまま）
- [ ] 上限を守る仕組みを壊すと、認可ポリシーの変異計測が検知する
- [ ] 既存のデータには触れない（`migration` が既存の行を読まない）

## 決めてほしいこと

| # | 決めること | おすすめ | 理由 |
| --- | --- | --- | --- |
| 1 | **どこで守るか**: RPC の中で数える（A）／明細の表にトリガーを付けて、どの経路でも数える（B） | **A** | 明細の表への直接の書き込みは、利用者の権限からは既に取り上げてある（2026-09-09）。利用者が通れるのは RPC だけなので、A で利用者の経路は全部塞がる。B は `service_role` の経路まで塞ぐが、行を足すたびに親の明細を数え直すので、明細が多い発注ほど遅くなる。B にするなら、既存の行が 100 件を超えていないかを本番で先に数える必要がある |
| 2 | 上限の値を DB のどこに置くか | 共有関数の中に 1 つ書き、設定との一致を検査で機械的に突き合わせる | DB の関数は設定ファイルを読めない。文字数の上限（DB の CHECK）と同じやり方。数字は migration に 1 か所だけ書く |
| 3 | 止まったときのエラーの種類 | 文字数の上限と同じ種類（`23514` check_violation）と、「何件までか」が読める文言 | API の入口が先に止めるので、このエラーに当たるのは RPC を直接呼んだ場合だけ。画面の文言は変えない |
| 4 | `service_role` の経路 | 今回は塞がない | 1 番で A を選ぶ場合の帰結。鍵を持つ運用者の経路で、利用者は通れない。塞ぎたくなったら B を別の issue で |

## 先にお伝えしておきたいこと

- **A を選ぶと、本番のデータを先に数える必要はありません。** issue に「既存データに 100 件を超える発注があると migration が失敗しうる」とありますが、それは B（表の制約）の場合です。A は関数の定義を変えるだけで、既存の行を読みません
- 上限（100 件）そのものは変えません。値を変える判断は、この仕様書の範囲外です
- RPC 4 本を書き直します。決まり（「最後に定義した版を元にする」）に従い、それぞれの最新の定義（症例・短貸発注は 20260908020000、消耗品発注・返却は 20260909080000）を元に、上限の確認を 1 行足すだけにします。認可の判定（施設の書き手か・二段階認証か）は変えません

---

# Part 2 — 実装計画（AI 用・レビュー不要）

## 根拠（2026-09-30 調査）

- 入口の上限: `src/lib/validation/text-limits.ts` の `ORDER_ITEMS_MAX` と `limitedItems()`（issue #813、PR #822）。値は `aidd.config.json` の `limits.orderItemsMax`（100）
- RPC の最新の定義: `create_case_order_atomic` / `create_loan_order_atomic` → `20260908020000_create_orders_as_confirmed.sql`。`create_consumable_order_atomic` / `create_loan_return_atomic` → `20260909080000_add_assert_facility_owns.sql`。4 本とも `p_items JSONB` を受け、`jsonb_array_elements(COALESCE(p_items, '[]'::JSONB))` で明細を展開する
- 明細の表への直接 INSERT は `20260909040000_revoke_direct_order_insert.sql` で利用者から取り上げ済み（操作の契約 O-xxx で「禁止」）
- 共有関数の前例: `assert_facility_owns`（20260909080000）。`SECURITY INVOKER`・`SET search_path = ''`・利用者ロールから REVOKE。変異の登録簿では、共有関数を no-op にする 1 本（RM-018）と、各 RPC が呼ぶのをやめる形（RM-016 / RM-017）で対になっている
- 設定と DB の突き合わせの前例: `scripts/check-text-length-consistency.test.sh`（migration の CHECK に現れる数字が、すべて設定の値のどれかと一致すること）

## 実装セット（決めてほしいこと 1 が A の場合）

| セット | 触るファイル | 内容 |
| --- | --- | --- |
| A | `supabase/migrations/20260930000000_limit_order_items_count_in_rpc.sql`（新規） | 共有関数 `assert_items_within_limit(p_items JSONB)` を新設（件数が上限を超えたら `check_violation` で落とす。NULL・空は通す）。4 本の RPC を最新の定義から書き直し、認可の判定の直後に `PERFORM public.assert_items_within_limit(p_items);` を 1 行足す。`-- release-order: db-first`・`-- design:`・`-- ROLLBACK:` を書く。表の DDL は無いので `-- lock:` は不要 |
| B | `scripts/check-order-items-limit-consistency.test.sh`（新規） | migration の共有関数に書いた数字が `aidd.config.json` の `limits.orderItemsMax` と一致すること。RED 方向（数字をずらした fixture で落ちる）も測る |
| C | `supabase/__tests__/integration/order-items-limit-boundary.integration.test.ts`（新規） | 4 種の RPC を**直接**呼び、101 件で `23514`・100 件で成功・止まったときヘッダが残らない、を実 DB で固定。describe 名に `[I-038]` |
| D | `scripts/lib/rls-mutants.json` | RM-021: 共有関数を no-op にする（expect は C）。RM-016/017 と同じ「呼ぶのをやめる」形は、4 本ぶんの本体の写しになるので作らない（C が 4 本すべてを直接呼ぶので、呼び忘れは C 自身が捕まえる） |
| 統合 | `docs/agents/invariant-catalog.md`（I-038、区分 03x「関係の個数」）、`docs/agents/quota-inventory.md`（該当する行があれば「RPC でも守る」に更新）、`src/lib/validation/text-limits.ts` のコメント（「限界: 効くのは API の入口だけ」を直す）、`docs/agents/file-index.md`、`docs/agents/harness-map.md`（新しい検査の登録）、`supabase/__tests__/integration/rpc-reference-boundary.integration.test.ts`（登録簿の ratchet に共有関数が引っかからないことを確認。REVOKE 済みなら公開 RPC ではない） |

## テスト観点

- 4 本 × 両方向（101 で止まる・100 で通る）。0 件・NULL は通る（既存の動きを変えない）
- 止まったときヘッダが残らない（`count` の前後比較。既存の boundary テストと同じ形）
- 再送（`client_request_id`）の経路より前で数える（上限超えの再送が「再送として通る」ことがない）
- 設定の数字を変えると B が落ちる（RED）。migration の数字を変えても落ちる
- 共有関数を no-op にすると C が落ちる（RM-021 で実測）
- 既存の統合テスト全件（`bash scripts/run-integration-tests.sh`）と、認可の変異計測（`bash scripts/check-rls-mutation.sh`）を回して記録する
- `scripts/check-guard-regressions.test.sh`（再定義で認可の判定が消えていないこと）と `scripts/check-design-questions.test.sh`（`-- design:` の有無）が緑

## 決めてほしいこと 1 が B（トリガー）の場合の追加

- 明細の表 4 つに `AFTER INSERT` のトリガーを付け、親ごとの件数を数える。`NOT VALID` が使えない（トリガーは既存行を見ない）ので、本番の既存行を先に数える SQL を人に打ってもらう
- 明細の多い発注ほど INSERT が遅くなる（1 行ごとに親の件数を数える）。`measure-scale.sh` で 100 件の発注を作る時間を前後で測る

---

# Part 3 — セルフチェック（AI 用・レビュー不要）

- UI 変更: なし
- 新しい値: なし（100 は既に人が決めた値。置き場所が増えるだけ）
- 列挙: RPC 4 本（症例発注・短貸発注・消耗品発注・短貸返却）。統合テストの観点は 4 本 × 2 方向 + ヘッダ残存 + 0 件・NULL
- 信号の意味: 利用者に見える動きは変わらない。RPC を直接呼んだときだけ、新しく `23514` が返る
