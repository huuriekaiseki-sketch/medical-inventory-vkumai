-- supabase/migrations/20260909040000_revoke_direct_order_insert.sql
-- release-order: db-first
-- design: 権限=**発注 3 種・返却とその明細（8 表）への直接 INSERT を authenticated から外す**
--         （人の判断、2026-09-09）／大きさ・量は変えない／消えるとき=変えない／
--         記録=既存の監査トリガーのまま（RPC 経由の INSERT はこれまでどおり残る）／外部送信なし
-- cardinality: many
--
-- WHY(発注は RPC からしか作れないようにする): 発注・返却の作成は
--      `create_case_order_atomic` / `create_consumable_order_atomic` / `create_loan_order_atomic` /
--      `create_loan_return_atomic` の 4 つだけが行う。いずれも SECURITY DEFINER なので
--      **定義者の権限で INSERT する**。つまりクライアント（`authenticated`）の INSERT 権限は
--      一度も使われていない。
--
--      残しておくと、**RPC が守っている約束を飛ばして行を作れる**:
--        - 単価スナップショット（発注時の仕入価格の写し取り）が入らない
--        - 作成＝確定（`status = 'submitted'`、E-052）が効かず、任意の状態で作れる
--        - ヘッダと明細の一括性（片方だけ入る）が壊れる
--      画面にその道が無いだけで、セッションを奪われれば API を直接叩ける。**入口を 1 つにする。**
--
-- WHY(2026-09-09 に数えて分かった): 「DB は書けるのにアプリに道が無い」組み合わせを機械で数えたら
--      20 件あり、DELETE 8 件・UPDATE 4 件を剥がして残りが**この 8 件の INSERT だけ**になった
--      （`scripts/lib/check-write-path-gaps.mjs`）。これで 0 件になる。
--
-- WHY(元をたどると `GRANT ALL`): 20260624000000 が 9 表へ
--      `GRANT ALL ON TABLE ... TO postgres, anon, authenticated, service_role` と書いていた。
--      **誰も「authenticated が発注を直接 INSERT してよい」とは決めていない**。`ALL` に付いてきただけ。
--      広げるのは 3 文字、狭めるのは動詞ごとの書き分け、という非対称が積もったもの。
--
-- WHY(aal2 の測り方が変わる): これまで `facility_writer_or_admin` の `has_aal2()` は
--      「aal1 の直接 INSERT が拒否される / aal2 なら通る」で測っていた。道が無くなるので、
--      **同じ判定を UPDATE（取り消し）側で測る**ように移す
--      （`require-aal2-in-facility-writer-rls.integration.test.ts`）。
--      RPC 側の `has_aal2()` は `require-aal2-for-order-rpcs.integration.test.ts` が引き続き測る。
--
-- 対象外: `consumables` / `hospital_prices` の INSERT はアプリが直接書く（道がある）。
--      `service_role` は変えない（テストの後片付けとシードが使う）。
--
-- ROLLBACK:
--   -- 8 表それぞれについて（<t> と <条件> は 20260909020000 の CREATE POLICY と同じもの）
--   CREATE POLICY "facility_writer_or_admin_insert" ON <t> FOR INSERT TO authenticated
--     WITH CHECK (<条件>);
--   GRANT INSERT ON TABLE <t> TO authenticated;

-- =========================================================================
-- 1) 発注 3 種と返却
-- =========================================================================
DROP POLICY IF EXISTS "facility_writer_or_admin_insert" ON case_orders;
REVOKE INSERT ON TABLE case_orders FROM authenticated;

DROP POLICY IF EXISTS "facility_writer_or_admin_insert" ON consumable_orders;
REVOKE INSERT ON TABLE consumable_orders FROM authenticated;

DROP POLICY IF EXISTS "facility_writer_or_admin_insert" ON loan_orders;
REVOKE INSERT ON TABLE loan_orders FROM authenticated;

DROP POLICY IF EXISTS "facility_writer_or_admin_insert" ON loan_returns;
REVOKE INSERT ON TABLE loan_returns FROM authenticated;

-- =========================================================================
-- 2) 明細 4 表
--
-- これで `case_order_items` / `consumable_order_items` / `loan_order_items` は
-- **クライアントから書く道が 1 つも無くなる**（読みだけ）。
-- `loan_return_items` は品目ごとの取り消し（status の UPDATE）だけが残る。
-- =========================================================================
DROP POLICY IF EXISTS "facility_writer_or_admin_insert" ON case_order_items;
REVOKE INSERT ON TABLE case_order_items FROM authenticated;

DROP POLICY IF EXISTS "facility_writer_or_admin_insert" ON consumable_order_items;
REVOKE INSERT ON TABLE consumable_order_items FROM authenticated;

DROP POLICY IF EXISTS "facility_writer_or_admin_insert" ON loan_order_items;
REVOKE INSERT ON TABLE loan_order_items FROM authenticated;

DROP POLICY IF EXISTS "facility_writer_or_admin_insert" ON loan_return_items;
REVOKE INSERT ON TABLE loan_return_items FROM authenticated;

-- テーブルの新設・削除ではないため refresh_schema_baseline_snapshot の呼び出しは不要。
