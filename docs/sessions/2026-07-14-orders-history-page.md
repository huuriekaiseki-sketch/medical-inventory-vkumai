# 2026-07-14 orders-history-page（issue #20）

## 作業サマリ
- 変更した目的: issue #20「発注履歴ページ（/orders）: 4種別の発注を横断して一覧・検索」の実装。症例発注・消耗品発注・短貸発注・短貸返却を横断表示するページを新設した
- 変更した範囲: `.aidd/run-manifest.json`記載の実装一式（マイグレーション・型定義・repository4本のフィルタ拡張・unified-repository・`/api/orders`・`/api/user-facilities`・UIコンポーネント3点・`/orders`ページ）＋停止②（構造化レビュー）で発見した2件の修正（用語統一・本ファイル）
- 触っていない範囲: issue #23（分析・レポート）関連コード。issue自身が「本issue完了後に着手推奨（案5）」としており、本issueはその前提条件

## 経緯（AIDDフロー）
- Phase 1: `aidd-1-1-deep-task`（92エージェント）でコード調査・SPEC.mdドラフト生成
- 停止①: 判断が必要な点6件を人間が回答し承認（2026-07-14T19:40:00+09:00）
- Phase 3-5: `aidd-phase2`で並列実装・統合ゲートまで完了したが、4観点レビューが3回差し戻しても以下2件のimportant指摘を解消できずblocked
  1. `parseKinds()`が`order_kinds=`（空文字＝0種別選択）を「未指定」と誤判定し、全チェックボックス解除後にURL直リンク/リロードすると無警告で全種別表示される不具合
  2. SPEC.mdが「詳細ページへ遷移」を前提にしていたが実際は単票詳細ページが存在せず一覧ページへリンクという乖離が仕様書に未反映
- 局所上限（3回）到達のため人間（Claude Codeセッション）が直接修正・独立レビューエージェントでPASS確認
- 停止②（`/structured-review`）で追加2件を発見・修正: (1) 用語不一致（`貸出発注/貸出返却` → 用語集`docs/agents/domain.md`および既存UI(`OrderButtons.tsx`)に合わせ`短貸発注/短貸返却`に統一）、(2) 本ファイル（空テンプレの重複記録2件を統合・実内容に書き換え）

## 検証済み
- 実行したコマンド: `npx vitest run`（739テスト全pass）、`npm run lint`（0件）、`npx tsc --noEmit`（0件）。`npm run ai:check`はE2E（要ローカルSupabase起動）を含むため未実行
- 確認した画面: なし（ブラウザでの実動作確認は未実施）
- 確認したDB/RLS: 新規RLSポリシー追加なし。既存の`facility_member_or_admin`ポリシーを踏襲
- 他テナントのIDでアクセスし、弾かれることを確認したか: 既存の`case/consumable/loan-orders-rls-idor.integration.test.ts`（DB層IDORテスト、変更なし）でカバー済みの範囲を再利用。`/api/orders`自体の専用IDOR統合テストは未追加（route.test.tsのモックDBレベルでの403/400確認のみ）

## 既知の未対応
- `/api/orders`専用のRLS/IDOR統合テスト（実DB）は未追加。理由: 新規RLSポリシーは追加しておらず既存テスト済みの関数を再利用しているため優先度を下げた
- レビューで検出されたminor指摘2件は未修正（minorのみのfailは品質ゲート通過扱いのため）: (1) `assertValidListOptions`の専用テストファイルが無く、4つのrepository testに同種テストが不揃いに重複、(2) jan経由の2段階検索クエリがcase-orders/loan-returns間で重複
- ブラウザでの実動作確認（Playwright等）は未実施
- 既存コードベース内に「短貸発注/短貸返却」（`OrderButtons.tsx`・`LoanOrderModal.tsx`等）と「貸出発注/貸出返却」（dashboard・既存`/api/loan-orders`コメント等）の用語混在が本issue着手前から存在することが判明した。本issueの新規ファイルは前者に統一したが、既存箇所の統一は本issueのスコープ外として対応していない

## 後任AIへの注意
- この実装で壊してはいけない前提: `parseKinds()`は`param === null`（未指定）と`param === ''`（0種別明示選択）を区別する。`!param`のようなfalsy判定に戻すと空文字誤判定バグが再発する
- 似ているが別物の用語: `case_orders.created_at`（レコード作成日時）と`case_orders.case_datetime`（症例実施日時）は別カラム。期間フィルタは`case_datetime`を使う。「短貸」（loan_order/loan_return、正式名称）と「貸出」表記の混在は既知の技術負債であり、本issueの範囲では新規ファイルのみ統一済み
- 勝手にリファクタしない場所: `src/lib/orders/unified-repository.ts`のjan/consumable_id経由サマリーラベル解決ロジック（N+1回避のためバッチIN句設計、SPEC.md記載通り）
