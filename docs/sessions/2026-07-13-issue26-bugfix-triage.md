# 2026-07-13 issue26-bugfix-triage

## 対応issue
- issue #26「既存バグ・DB問題の修正（旧Phase1調査214件ベース）」

## やったこと
issue #26 の5項目それぞれについて、既にissue #24（closed）・issue #25（open, PR #328でSET D/I対応済み）で
重複解消されていないかを5並列Exploreエージェントで調査した上で、実際に残っていた項目のみ修正した。

### 項目ごとの判定と対応

| 項目 | 判定 | 対応 |
|---|---|---|
| 1. セキュリティ修正（RLS・SECURITY DEFINER最小権限化等） | 対応済み（issue #24等） | 変更なし |
| 2. DB設計バグ（CASCADE・JAN未紐付け・インデックス） | CASCADE/インデックスは対応済み。consumables.janが未FK化だったため一部残課題 | `supabase/migrations/20260714000004_link_consumables_jan_and_validate_fk.sql` でconsumables.janのFK追加＋既存jan FK群のVALIDATE CONSTRAINT実行 |
| 3. エラーハンドリング統一 | APIレスポンス統一・handleDelete await漏れは対応済み。products/page.tsxのcatch漏れのみ残課題 | `src/app/products/page.tsx` にcatch追加・エラー表示UI追加 |
| 4. 型安全性（無条件キャスト） | repository層はPR #328で対応済み。admin/users/route.tsのみ未対応 | `src/app/api/admin/users/route.ts` の `role as 'admin'\|'staff'` を `asEnum()` に置換 |
| 5. UI・フォームバグ | ホバースタイル・ItemRowInput key・金額バリデーションは対応済み。CaseOrderModalの必須項目バリデーション欠落のみ残課題 | `src/components/orders/CaseOrderModal.tsx` に caseDatetime/patientId/patientInitials/doctorName の空送信バリデーションを追加 |

### あえて対応しなかったこと
- **AbortController未導入・注文一覧4ページ（case-orders/consumable-orders/loan-orders/loan-returns）のcancelledガード**: React 19ではアンマウント後のsetStateが無害化される（警告も出ない）ため、実害のある不具合として再現できなかった。プロジェクト全体へのAbortController導入は本issueのスコープを超える大掛かりな変更になるため見送った。issue #25 SET Bとして引き続き管理する。
- **LoanReturnModalのreturnDatetimeバリデーション**: 現状HTML `required` 属性で空送信は防げており機能的なバグではない（CaseOrderModalは`*`表示があるのにJSチェックが完全に欠落していた点が実バグだった）。実装方式の不統一のみで、今回は対象外とした。

## フロー実行時間
- Phase 1（調査・重複確認）: 並列Exploreエージェント5台、約3.5分
- Phase 2〜5（実装）: TDD（Red→Green）で4項目を直列実装
- AI稼働合計: 約40分
- セッション総時間: 人間レビュー（進め方確認の1回）含め約45分

## フロー実行統計
### Phase 1 調査
- Sweeper: Explore agent 5台 × 1ラウンド（並列）
- 指摘あり軸数: 4 / 5（項目1は指摘なし＝対応済み確認のみ）

### Phase 2〜5 実装・検証
- implementer: 本セッション内で直接実装（1名・直列、TDD Red→Green）
- integrator: 該当なし（単一セッション内完結）
- reviewer: 該当なし（npm test / lint / tsc --noEmit で検証）
- 合計エージェント: 5台（Phase1のみ）
- 実装成功: 4 / 4項目

## Loop Observability要約
このセッション中の新規記録なし（AIDDフロー本体を経由しないTDD直接実装のため対象外）

## 検証済み
- 実行したコマンド: `npx vitest run`（630件全緑）, `npm run lint`（エラーなし）, `npx tsc --noEmit`（エラーなし）, `supabase db reset --local`（新規マイグレーション適用確認）。`npm run ai:check` は `test:e2e` が `.env.test` 未設定によりこの環境では実行不可（既存の環境制約であり今回の変更による回帰ではない）
- 確認した画面: なし（バックエンド・単体テストのみで検証）
- 確認したDB/RLS: ローカルSupabaseで新規migrationの冪等性・既存jan FKのVALIDATE CONSTRAINT成功（孤児データ0件）を確認
- 他テナントのIDでアクセスし、弾かれることを確認したか: 対象外（今回の変更はRLS/facility境界に触れていない）

## 結果
- うまくいったこと: 5並列調査により214件ベースの旧issueのうち大部分が既に他issueで解消済みと判明し、実装が必要な範囲を4件の小さな変更に絞り込めた
- 問題・気になった点: consumables.jan FKはNOT VALIDで追加後にVALIDATE CONSTRAINTしているが、本番DBに孤児データが存在する場合はデプロイ時にマイグレーションが失敗する（意図的な挙動だが、事前に本番データを確認できていない）
- 次の課題: issue #25 SET B（AbortController・catch漏れの残り）、issue #25 SET A/C/E/Gは本issueの対象外のため引き続きissue #25側で管理

## 後任AIへの注意
- この実装で壊してはいけない前提: `consumables.jan` は nullable のまま（NOT NULL化はしていない）。FKはNULLを許容する
- 似ているが別物の用語: issue #26項目2の「SET A由来のインデックス追加」という記述は誤り。実際のインデックス追加は`20260629000003`（SET F/H系列）
- 勝手にリファクタしない場所: `src/lib/mapping.ts` の `asEnum` 等の型ガード関数はissue #25 SET Iの成果物であり、シグネチャを変えると他repositoryとの整合性が崩れる
