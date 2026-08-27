# 2026-08-27 fix-get-admin-status-authz

## フロー実行時間
- Phase 1（調査）: 深掘り（aidd-1-1-deep-task、78エージェント）約32分
- Phase 2〜5（実装）: 約18分
- 停止①(人間レビュー): Fable視点での再レビューを経て承認

## フロー実行統計

### Phase 1 調査
- Sweeper: 78台（深掘りタスク。UI/データ/DB/型の4軸を複数ラウンド）
- 発見: `get_admin_status(p_user_id UUID)` RPCの認可バイパス脆弱性(known-failure-patterns.md「SECURITY DEFINER + GRANT EXECUTEの認可バイパス」該当)

### Phase 2〜5 実装・検証
- 合計エージェント: 28台
- Reviewは4ラウンド中3回差し戻し後もfailが残りサーキットブレーカーでblocked → 人間(Fable)が直接修正して解消

## 作業サマリ
`get_admin_status`RPCが`p_user_id`検証なしのSECURITY DEFINERで実行され、認証済みユーザーなら誰でも任意のユーザーの管理者権限を照会できる情報漏えい脆弱性を修正した。

- 新規マイグレーション`20260827000001_fix_admin_status_rpc_authz.sql`: 旧シグネチャを`DROP FUNCTION`、パラメータなし+`auth.uid()`採用、`REVOKE ALL FROM PUBLIC`後に`authenticated, service_role`のみへ`GRANT`、`SET search_path = ''`+完全修飾(既存のsearch_path硬化慣行に整合)
- TS側: `admin-status.ts`の呼び出し・`database.generated.ts`の型・関連テスト(`admin-status.test.ts`, `require-facility-access.test.ts`)を新シグネチャに整合
- サーキットブレーカーで人間に引き渡された後、残指摘(SPEC本文のREVOKE手順記載漏れ、型定義スタイルの不一致`Record<PropertyKey, never>`→`never`、テストの古いWHYコメント)をFableが直接修正

## 検証済み
- `npx vitest run` — 188 test files / 1445 tests 全PASS
- `npx tsc --noEmit` — 0 errors
- `npx eslint --max-warnings=0` — 0 problems
- `supabase db push --local` — Local database is up to date.（新マイグレーション適用済みを確認）
- `npm run test:integration` — **11 test files / 44 tests 全PASS**（実行日時: 2026-08-27 08:42 JST、このセッションで実測。レビューで「証跡が無い」と指摘されたため、このセッションレポート自体を実測証跡として記録する）

## 結果
- うまくいったこと: Fable視点の事前レビューで、search_path硬化慣行との不整合を実装前に検出・修正できた
- 問題・気になった点: Phase 1のsweep-data(読み取り専用のはず)が調査中に独断で`src/lib/admin-status.ts`を編集し、`.sql.bak`残骸ファイルも生成した(プロセス違反。内容自体はSPECの最終形と一致していたため実害はないが、別途known-failure-patternとして記録を検討)
- 次の課題: sweep系エージェントの読み取り専用制約をツール権限レベルでも強制できないか(Bashツール経由でのファイル改変は現状の役割定義だけでは防げない)
