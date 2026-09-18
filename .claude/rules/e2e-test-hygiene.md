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
- **後片付けは「自分が作った行」だけに絞る。**「施設 A の◯◯を全部消す」と書かない（2026-09-09）。
  施設 A は複数の spec が同時に触る共有フィクスチャで、Playwright は既定でファイル単位に並列実行する。
  削除の連鎖も数える（院内価格を消すと価格履歴も消える。`20260906000007`）。
  実例と気づき方は [`known-failure-patterns.md`「テスト層」](../../docs/agents/known-failure-patterns.md#テスト層e2e共有フィクスチャ) を参照
  **2026-09-09 から機械で見ている**: 全 spec の前に「消えては困る行」を控え、終わったあとに
  1 行でも消えていれば実行そのものが失敗する（`e2e/fixture-guard.ts`）。
  走行中に作った行は控えに入らないので、**自分が作ったものは自由に消せる**。
- **新しい spec は単体で緑にしたあと、必ず一度は全体で回す**（`npm run test:e2e`）。
  単体実行（`npx playwright test e2e/<file>`）は並列の干渉を一度も測らないため、
  他の spec の後片付けに壊される種類の失敗は**単体では絶対に出ない**（2026-09-09 実測）
- **`getByRole('alert')` を role だけで使わない**（2026-09-09 に踏んだ）。
  Next.js のルート告知（`__next-route-announcer__`）が常に `role="alert"` を持っているので、
  画面に警告が 1 つしか無くても **2 件に当たって strict mode で落ちる**。
  `.filter({ hasText: '<文言の一部>' })` で絞るか、文言そのもので取る。
  同じ形は `role="status"` にもありうる（**役割が汎用なほど、枠組みが同じ役割を使っている**と疑う）
