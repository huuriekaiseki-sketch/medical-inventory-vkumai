---
paths:
  - "e2e/**"
---

# テスト環境・データ衛生ルール

- **E2E/BSGはテスト専用Supabaseのみに接続する。** 接続情報は `.env.test` に置く（`.env.test.example` 参照）。
  `NODE_ENV=test` のため `.env.local`（本番）は読み込まれず、さらに `e2e/env-guard.ts` が
  許可ホスト以外（＝本番URL・本番service role実行）を**即失敗**させる
- **認証ファイル（`e2e/.auth/user.json`）の漏洩チェックはCI側で行う**（`.github/workflows/ci.yml`の
  hooks-testジョブ。BSG（ローカルゲート）ではチェックしない方針）
- **E2E/integrationテストのCI自動実行はmainへのpush後と手動起動のみ**（2026-08-25、Actions
  無料枠対応で`e2e.yml`のPRトリガーを廃止）。PR段階では `npm run test:e2e` /
  `npm run test:integration` をローカル実行し、結果を引き継ぎメモの「検証済み」欄に記載する
- **seed・スクリーンショット・E2E失敗ログ・issue添付に実在施設名・実データを入れない。**
  施設名・ユーザー名・在庫品目などはすべてダミー（例: `テスト施設A`、`e2e-test-user@example.com`）を使う
