# 2026-09-20 issue-809-order-detail

## 30秒サマリー
- 変更概要: 症例発注・短貸返却を 1 件開いて中身（患者の情報・明細のロットと使用期限）を確認できる詳細ページと、ID 指定の取得 API を足した
- リスク: 中（患者の情報を返す読み取り経路が 2 本増える。DB・RLS・migration は変えていない）
- 変更領域: UI / API Route / repository / 拒否の記録（`HiddenRowTable`）
- 証拠状態: 実測 7 件（型検査・lint・unit 2420・build・統合 395・E2E 100・hook 155）/ 未検証 1 件（テストの外からの手動の直接攻撃）
- 影響範囲: 新しい 2 ページと GET 2 本。既存の一覧 3 画面（施設ごとの一覧 2 つ・`/orders`・ロット検索）に詳細へのリンクが増える。既存の PATCH（取り消し）は変えていない
- ロールバック可能性: 高（revert のみ。DB の変更が無い）

レビューしてほしい点:
1. 認可の形が `hospital-prices/[id]` の GET と同じ「先引き → 施設判定」になっているか（見つからない・他施設のどちらも 404、拒否は `access_denials` に残す）
2. 詳細ページに出している項目が、決定 A（登録した全項目）と合っているか

## 00 目的・影響範囲・対象外
- 目的: issue #803（ロット検索）で「行から発注を開けば患者が分かる」と決めたのに、開く先のページが無かった。それを作る（issue #809）
- 変更範囲: `GET /api/case-orders/[id]`・`GET /api/loan-returns/[id]`、`getCaseOrder`・`getLoanReturn`、詳細ページ 2 つ、3 か所の入口（決定 C）、`STATUS_LABEL` の `cancelled`
- 対象外（今回あえて触らない）: 短貸発注・消耗品発注の詳細、ページ送り（決定 D）、正規の閲覧の記録（決定 E。弾かれた試行は残す）、編集
- 作業中に見つけた別件: 1 件の発注の明細件数に上限が無い／ロット検索の画面側に `LOT_MAX_LENGTH = 100` の直書きが残っている（どちらも未起票。次のセッションで起票する）
- 依存の変更: なし

## 01 画面がどう変わったか（UI証拠）
- スクリーンショットは撮っていない。画面の確認は E2E（`e2e/order-detail.spec.ts` の 7 本）で実測した
- 一覧の行 →「詳細を見る」→ 詳細ページ → キーボードだけで一覧へ戻る、を E2E が通している

## 02 内部でどう守っているか（ロジック証拠）
- route: `requireAuth` → ID の形式（UUID でなければ 404。DB に投げない）→ `get*`（null なら `recordHiddenRowDenial` + 404）→ `requireFacilityAccess`（失敗も 404）。`src/app/api/case-orders/[id]/route.ts`・`src/app/api/loan-returns/[id]/route.ts`
- repository: 行→型の写しを `mapCaseOrder`・`mapLoanReturn` に 1 本化（一覧・作成・1 件取得で共有。中身は変えていない）
- 画面: URL の施設 ID と記録の `facilityId` が食い違えば「見つかりません」（API はクライアントが渡す施設 ID を信用しないので、突き合わせは画面の責務）

## 03 誰が操作できるか（RLS/権限証拠）
- RLS・migration の変更: なし（既存の読み取りポリシー `has_aal2() AND (is_facility_member OR is_admin)` に乗る）
- 他テナントの ID でアクセスし、弾かれることを確認したか: した。
  - RLS の層: `order-detail-rls-idor.integration.test.ts` が、**他施設の一般メンバー**のクライアントで出荷する `getCaseOrder`・`getLoanReturn` を呼び、null を実測（admin は RLS を全施設ぶん通るので、admin だけでは測れない）
  - API の層: `e2e/api-cross-facility-attack.spec.ts`（攻撃表の総当たり。新しい GET 2 本を載せた）
  - 画面の層: 他施設の利用者が詳細 URL を直接開くと「見つかりません」で、患者の情報は出ない（E2E）
- 該当する約束: P-013（1 件取得は施設スコープ）・P-015（自施設は通る）・P-017（攻撃表）・P-063（RLS で見えない取得を拒否として残す）

## 04 どう確認したか（テスト・検証）
| 種別（test-matrix.md の行） | 状態 | 結果・証跡 |
| --- | --- | --- |
| 型検査 | ✅ 実施 (自動テスト: パス) | `npx tsc --noEmit` エラー 0 |
| lint | ✅ 実施 (自動テスト: パス) | `npm run lint` 警告 0 |
| unit（UI・データ層・API Route） | ✅ 実施 (自動テスト: パス) | `npm test` 259 ファイル・2420 件 |
| build | ✅ 実施 (自動テスト: パス) | `npm run build`。新しい 2 ページと GET 2 本が route 一覧に出る |
| hook 回帰 | ✅ 実施 (自動テスト: パス) | `scripts/*.test.sh` を止めずに全 155 本。1 回目はこのファイルが空テンプレートで 1 本落ち、書き直して通した |
| RLS/IDOR 統合（実 DB） | ✅ 実施 (自動テスト: パス) | `bash scripts/run-integration-tests.sh` 51 ファイル・395 件、消し残し 0 |
| 生成型の鮮度 | ✅ 実施 (自動テスト: パス) | `bash scripts/check-generated-supabase-types.sh` up to date |
| 直接攻撃の実測（テスト外） | 🟡 一部 | 自動の攻撃表（`api-cross-facility-attack.spec.ts`）は通した。テストの外から手で叩く確認はしていない |
| 業務不変条件（DB 制約） | ✅ 実施 (自動テスト: パス) | 統合テストに含まれる。書き込みの経路は変えていない |
| E2E（Playwright） | ✅ 実施 (自動テスト: パス) | `bash scripts/run-e2e-tests.sh` 100 件 |
| 依存差分レビュー | ➖ 今回不要 | package.json / package-lock.json に触れていない |
| 冪等性 / 同時実行 | ➖ 今回不要 | 読み取りだけで、作成 route・RPC に触れていない |

- fault injection: `getCaseOrder` の `select('*, case_order_items(*)')` から明細の埋め込みを外す → 統合テストの 2 本（自施設の対照・admin）が落ちる → 戻して緑
- **実装フローが書いた統合テストは、出荷する関数を 1 回も呼んでいなかった**（生の `select('*')` を手書きしていた）。上の破壊はその版では素通りだった。関数を呼ぶ形に人が書き直し、明細（ロット・使用期限）・取り消し済みの明細・aal1 のケースを足した
- verify-claims は未実施

## 05 何かあったらどうするか（観測・ロールバック）
- リリース後に見るログ/メトリクス: `/admin/audit` の「拒否された操作」（`case_orders`・`loan_returns` の `hidden_row`）
- 異常の判断基準: 同じ利用者から短時間に多数の `hidden_row`（ID の総当たり）
- ロールバック手順: PR を revert（DB の変更なし）

## 後任AIへの注意
- この実装で壊してはいけない前提: 「見つからない」と「他施設」を応答で区別しない（どちらも 404）。aal1 のセッションは RLS では拒否ではなく**空**になるので、届かせないのは proxy の MFA ガード（`src/__tests__/proxy.test.ts` の matcher のテストと対）
- 似ているが別物の用語: 返却の「回ごとの取り消し」（`loan_returns.status`）と「明細ごとの取り消し」（`loan_return_items.status`）
- 勝手にリファクタしない場所: `docs/specs/order-detail/SPEC.md` は承認済みで specHash が manifest に入っている。直すなら末尾に「承認後の訂正」として足す
