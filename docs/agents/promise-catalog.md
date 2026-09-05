# 約束カタログ（AAA）

守る約束の正本。1行 = 1約束。テストはこの行を写して書き、テスト名（`describe` / `it` / `test` の
文字列）に ID `P-xxx` を含める。範囲は **auth / RLS / facility 境界 / admin 境界 / AAL2 / RPC 契約** に
限定する（PR③。設計判断は [`decisions.md`](./decisions.md#なぜ約束カタログを-auth--rls--facility-境界に限定しid-をテスト側に書いて逆方向で検査するかpr2026-09-04)）。
UI や取込などそれ以外の層は [テスト一覧](./test-matrix.md) の種別として扱い、ここには載せない。

## 更新ルール

- 列は固定 9 列: ID / 約束 / Arrange / Act / Assert（肯定）/ Assert（否定）/ 境界値 / 守るテスト / 実施タイミング。
  列の中に `|` を書かない（列ずれは構造テストが違反として数える）。
- ID は `P-` + 3 桁。区分ごとに 10 刻み（認証 00x / 施設境界 01x / ロール・admin 境界 02x / AAL2 03x /
  RLS 衛生 04x / 施設境界に関わる DB 制約 05x）。欠番は詰めない（過去の PR 本文が ID を参照するため）。
- 守るテスト列はバッククォートでファイルパスを書く。**そのファイルの中に ID 文字列が実在する**ことを
  `scripts/check-promise-catalog.test.sh`（CI `hooks-test` ジョブ）が検査する（kojigyo の「ファイル存在
  だけ」の検査ではテスト名のリネームに追従しなかった穴を塞ぐ）。逆に、テストコードにあるのに
  カタログに無い ID も違反になる。
- 守るテストが無い約束は `未` と書き、[テスト一覧](./test-matrix.md) の該当種別が ⬜ / 🟡 であることと
  対応させる。`未` の行には ID 検査を掛けない。
- 実施タイミングは一覧と同じ 4 語（毎回 / 変更時 / 節目 / 一度きり）。「変更時」は derive
  （`scripts/derive-test-selection.sh`）が `rls-idor-integration` を required に出したとき。

## 認証（API Route の入口）

| ID | 約束 | Arrange | Act | Assert（肯定） | Assert（否定） | 境界値 | 守るテスト | 実施タイミング |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P-001 | 未認証の呼び出しは `requireAuth` が `UNAUTHORIZED` で止め、ハンドラ本体へ進まない | Supabase クライアントの `getUser` を差し替え | `requireAuth()` | 認証済みなら user を返す | user が null、または error ありなら `UNAUTHORIZED` を throw | error と user が両方ある場合は error 優先（未テスト） | `src/lib/supabase/__tests__/require-auth.test.ts` | 毎回 |
| P-002 | 施設に所属しない利用者は `requireFacilityAccess` が `FORBIDDEN` で止める。admin は施設指定なしでも通る | `is_facility_member` RPC と admin 判定（DB ロール / `ADMIN_EMAILS`）を差し替え | `requireFacilityAccess(user, facilityId)` | メンバーなら facilityId を返す。admin は `facilityId=null` でも通り RPC を呼ばない | 非メンバー・RPC error は `FORBIDDEN`。非 admin の `facilityId=null` は `FACILITY_ID_REQUIRED` | `facilityId=null`、RPC error | `src/lib/supabase/__tests__/require-facility-access.test.ts` | 毎回 |

## 施設境界（RLS / IDOR）

| ID | 約束 | Arrange | Act | Assert（肯定） | Assert（否定） | 境界値 | 守るテスト | 実施タイミング |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P-010 | 他施設の利用者は施設スコープの行（発注 3 種・返却・仕入価格・施設スコープの価格履歴）を 1 件も読めない。主キーを知っていても漏れない | 施設 A / B と各所属ユーザー、施設 A のシード行（`helpers/seed-rls-idor`） | ユーザー B が `from(table).select()`（施設 A 指定・主キー直指定） | — | error なし・`data` が空（RLS は拒否ではなく不可視） | 主キー直指定、`kind` 指定の横断履歴 | `supabase/__tests__/integration/case-orders-rls-idor.integration.test.ts`、`supabase/__tests__/integration/consumable-orders-rls-idor.integration.test.ts`、`supabase/__tests__/integration/loan-orders-rls-idor.integration.test.ts`、`supabase/__tests__/integration/loan-returns-rls-idor.integration.test.ts`、`supabase/__tests__/integration/hospital-prices-rls-idor.integration.test.ts`、`supabase/__tests__/integration/price-histories-rls-idor.integration.test.ts`、`supabase/__tests__/integration/orders-rls-idor.integration.test.ts` | 変更時 |
| P-011 | 他施設の利用者は施設スコープの行を更新・削除・作成できない。更新は 0 行、削除後も行が残り、作成は WITH CHECK で拒否される | 同上 | ユーザー B が `update` / `delete` / `insert`（施設 A 指定） | — | 更新が 1 行も反映されない。削除後に Admin 再読で行が残る。insert は error | 親 order 経由の明細、`facility_id` を施設 A にした insert | `supabase/__tests__/integration/hospital-prices-rls-idor.integration.test.ts`、`supabase/__tests__/integration/order-items-rls-idor.integration.test.ts` | 変更時 |
| P-012 | 発注・返却 RPC（`create_case_order_atomic` / `create_loan_order_atomic` / `create_consumable_order_atomic` / `create_loan_return_atomic`）に他施設の `facility_id` を渡すと forbidden で拒否される | 同上 | ユーザー B が RPC を施設 A の id で呼ぶ | 自施設なら成功し `facility_id` が一致（P-015） | `data` null・error あり（forbidden）。行が増えない | `search_path=''` 化後も同じ挙動 | `supabase/__tests__/integration/order-rpc-search-path-idor.integration.test.ts`、`supabase/__tests__/integration/case-orders-rls-idor.integration.test.ts`、`supabase/__tests__/integration/loan-orders-rls-idor.integration.test.ts`、`supabase/__tests__/integration/consumable-orders-rls-idor.integration.test.ts`、`supabase/__tests__/integration/loan-returns-rls-idor.integration.test.ts` | 変更時 |
| P-013 | 明細テーブル（`*_order_items` / `loan_return_items`）は親 order 経由で施設スコープになり、他施設からは読めず・更新できず・削除できず・親にぶら下げて作成できない | 施設 A の親 order と明細 | ユーザー B が明細を select / update / delete / insert | 自施設は取得できる | 0 件、更新 0 行、削除後残存、insert 拒否 | 主キー直指定 | `supabase/__tests__/integration/order-items-rls-idor.integration.test.ts` | 変更時 |
| P-014 | 横断発注履歴（`listOrders`）も施設境界を守り、他施設の発注は種別指定でも返らない | 施設 A の 4 種別発注 | ユーザー B が `listOrders`（kind 指定あり / なし） | ユーザー A は 4 種別全て取得 | 0 件 | `kind=loan_order` 指定 | `supabase/__tests__/integration/orders-rls-idor.integration.test.ts` | 変更時 |
| P-015 | 自施設の利用者は取得・作成できる（対照。拒否が RLS 由来であり、古い許可ポリシーの残存や全拒否の退行を検知する） | 同上 | ユーザー A が select / RPC / insert（施設 A） | シード行が含まれる。RPC が成功し `facility_id` が一致 | — | — | `supabase/__tests__/integration/case-orders-rls-idor.integration.test.ts`、`supabase/__tests__/integration/loan-orders-rls-idor.integration.test.ts`、`supabase/__tests__/integration/consumable-orders-rls-idor.integration.test.ts`、`supabase/__tests__/integration/loan-returns-rls-idor.integration.test.ts`、`supabase/__tests__/integration/hospital-prices-rls-idor.integration.test.ts`、`supabase/__tests__/integration/price-histories-rls-idor.integration.test.ts` | 変更時 |
| P-016 | 画面経由でも施設境界は守られる（他施設の一覧 URL を開くとアクセス権限エラーになり、シード済み発注が見えない） | Playwright の認証状態（ユーザー A / B）と施設 A のシード発注 | ユーザー B が施設 A の loan-orders 一覧を開く | ユーザー A は自施設の発注を閲覧できる | 権限エラー表示、発注が見えない | — | `e2e/cross-facility-boundary.spec.ts` | 節目 |

## ロール・admin 境界

| ID | 約束 | Arrange | Act | Assert（肯定） | Assert（否定） | 境界値 | 守るテスト | 実施タイミング |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P-020 | viewer ロールは閲覧のみ。直接 INSERT も発注 RPC も拒否され、同じ施設の staff は通る | 施設に viewer と staff を所属させる | viewer が `consumables` へ insert、発注 RPC 3 種を呼ぶ | viewer は select できる。staff は insert / RPC が成功 | viewer の insert は RLS で拒否、RPC は forbidden | — | `supabase/__tests__/integration/rbac-viewer-role.integration.test.ts`、`supabase/migrations/__tests__/add_viewer_role.test.ts` | 変更時 |
| P-021 | マスタ（`categories` / `products` / `distributor_products` / `product_compatibilities` / `facilities`）は参照がテナント非分離である代わりに、書き込みは admin だけができる。staff は作成・更新できない | staff（施設メンバーだが admin でない）と admin | staff と admin がマスタへ insert / update | admin は作成・更新できる。staff は参照できる | staff の insert は拒否、update は 0 行（価格の改ざんが通らない） | `facilities` は admin_insert ポリシー | `supabase/__tests__/integration/master-tables-admin-boundary.integration.test.ts`、`supabase/migrations/__tests__/admin_rls.test.ts` | 変更時 |
| P-022 | JWT の `user_role` クレームは `custom_access_token_hook` が埋め、どの施設にも所属しない利用者は null になる | 所属あり / なしの利用者 | サインインして JWT を読む | 所属に応じた role | 未所属は null | — | `supabase/__tests__/integration/custom-access-token-hook.integration.test.ts`、`supabase/migrations/__tests__/add_custom_access_token_hook.test.ts` | 変更時 |

## AAL2（MFA 昇格）

| ID | 約束 | Arrange | Act | Assert（肯定） | Assert（否定） | 境界値 | 守るテスト | 実施タイミング |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P-030 | MFA 登録済みの利用者は aal2 に昇格しない限り発注・返却 4 RPC を呼べない。MFA 未登録の利用者は aal1 のまま呼べる（既存利用者への回帰なし） | TOTP factor を enroll / verify した利用者と未登録の利用者 | aal1 / aal2 の各セッションで 4 RPC を呼ぶ | 未登録 aal1 は成功。登録済み aal2 は成功 | 登録済み aal1 は forbidden（aal2 required） | enroll 直後・verify 前 | `supabase/__tests__/integration/require-aal2-for-order-rpcs.integration.test.ts`、`supabase/migrations/__tests__/require_aal2_for_order_rpcs.test.ts` | 変更時 |
| P-031 | RPC を経由しない直接 INSERT でも `facility_writer_or_admin` ポリシーが `has_aal2()` を要求する（発注 3 種・返却・仕入価格・消耗品・明細 4 テーブル）。`facilities` の更新は意図的に対象外 | 同上 | aal1 / aal2 の各セッションで各テーブルへ insert | aal2 は成功。`facilities` の更新は aal1 でも成功 | aal1 は RLS で拒否 | 明細 4 テーブルは親経由の EXISTS + `has_aal2()` | `supabase/__tests__/integration/require-aal2-in-facility-writer-rls.integration.test.ts`、`supabase/migrations/__tests__/require_aal2_in_facility_writer_rls.test.ts` | 変更時 |
| P-032 | aal2 チェックは施設所属チェックの後に来る（施設非所属者に aal2 要求メッセージを先出しして、施設の存在や所属状態を漏らさない） | migration SQL | 静的検査で `is_facility_writer` と `has_aal2()` の出現順を比べる | 所属チェックが先 | — | — | `supabase/migrations/__tests__/require_aal2_for_order_rpcs.test.ts` | 毎回 |

## RLS 衛生（横断）

| ID | 約束 | Arrange | Act | Assert（肯定） | Assert（否定） | 境界値 | 守るテスト | 実施タイミング |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P-040 | 最終的に存在する全テーブルで RLS が有効、`DISABLE ROW LEVEL SECURITY` はどこにも無く、RLS 有効テーブルには `CREATE POLICY` が最低 1 つある（意図的 deny-all は許可リスト管理） | migration 全体をパース | 静的検査 | テーブルを 1 つ以上検出（パーサ自壊の検知） | DISABLE 無し、ポリシー 0 は許可リストのみ | 許可リストの陳腐化（実在しない・ポリシーが付いた） | `supabase/migrations/__tests__/rls_enabled_all_tables.test.ts` | 毎回 |
| P-041 | 発注・返却 RPC は `search_path=''` で完全修飾し、search_path hijacking で認可を迂回できない | migration SQL と実 DB | 静的検査 + 他施設 id で RPC を呼ぶ（P-012） | — | `search_path` が空でない RPC が無い。IDOR は拒否のまま | — | `supabase/migrations/__tests__/require_aal2_for_order_rpcs.test.ts`、`supabase/migrations/__tests__/add_viewer_role.test.ts`、`supabase/__tests__/integration/order-rpc-search-path-idor.integration.test.ts` | 毎回 |
| P-042 | `CREATE POLICY` を持つテーブルは `*-rls-idor.integration.test.ts` に一度は登場し、admin 限定書き込みのテーブルは admin 境界テストに登場する（新規発生を ratchet で止める） | migration と統合テストのファイル群 | `constraint-coverage.js` の判定 | — | baseline に無い新規の穴があれば失敗 | baseline と機械判定のズレ | `supabase/migrations/__tests__/constraint_coverage_ratchet.test.ts` | 毎回 |

## 施設境界に関わる DB 制約

| ID | 約束 | Arrange | Act | Assert（肯定） | Assert（否定） | 境界値 | 守るテスト | 実施タイミング |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P-050 | 短貸発注 1 件に返却は 1 件まで。2 回目の登録も、2 件の同時送信も 1 件だけ残る（issue #675） | 施設 A の短貸発注 1 件 | 同じ `loan_order_id` で返却登録を 2 回連続、および 2 件同時送信 | 1 回目は成功 | 2 回目はエラー。同時送信は成功 1 / 失敗 1、`loan_returns` 該当行は 1 件 | 同時送信 | `supabase/__tests__/integration/loan-returns-rls-idor.integration.test.ts` | 変更時 |
| P-051 | 価格履歴は直接 INSERT できず、SECURITY DEFINER トリガーだけが書き、価格が変わらない更新では増えない | 施設 A の仕入価格 | 自施設ユーザーが `price_histories` へ insert、`hospital_prices` を更新 | 価格変更で施設スコープの履歴が正しい内容で残る | 直接 insert は拒否（`price_histories_no_insert`）。同値更新で履歴が増えない | `IS DISTINCT FROM` | `supabase/__tests__/integration/price-histories-rls-idor.integration.test.ts` | 変更時 |

## まだ守るテストが無い約束

| ID | 約束 | Arrange | Act | Assert（肯定） | Assert（否定） | 境界値 | 守るテスト | 実施タイミング |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P-017 | API Route（`route.ts`）は全メソッドで `requireAuth` と `requireFacilityAccess` 相当を通り、他施設の実在するリソース ID を渡すと 403 / 404 になる（issue #24 の再発防止。現状は手動の「直接攻撃の実測」に依存） | 他施設の実在 ID | 各 route を他施設ユーザーで直接呼ぶ | 自施設は 200 | 403 / 404 | クエリ・パス・ボディの各 `facility_id` | 未 | 変更時 |
| P-052 | 同一注文・同一在庫行を複数ユーザーが同時更新しても整合が壊れない（楽観ロック・一意制約） | 同一行 | 並列更新 | 1 件だけ成功 | 競合側が拒否される | — | 未 | 変更時 |
