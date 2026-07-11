# SPEC: CIに2ユーザー×2施設のRLS/IDOR統合テストを追加する（issue #165）

## Part 1 — 仕様（人間レビュー対象）

### 何ができるようになるか

現在、「施設Aのユーザーが施設Bのデータを見れてしまう／操作できてしまう」というバグが起きても、テストでは検知できません。既存のテストは以下のいずれかで、実際のデータベース越境チェックを一度も通していないためです。

- RLS（行レベルセキュリティ）テスト → SQLの中身を文字列として読むだけ（本物のデータベースには繋がない）
- APIテスト → 「施設アクセス許可チェック」を常にOKを返す偽物に差し替えている（本物のチェックを迂回している）

この仕様では、**本物のテスト用データベースに、本物の2人のユーザーと2つの施設を用意し、「施設Aのユーザーが施設Bの短貸発注（loan-orders）データにアクセスしようとしたら、必ず拒否される」ことを実際に確認するテスト**をCIに追加します。これにより、将来誰かがうっかり越境チェックを壊すコードを書いても、CIが赤くなって気づけるようになります。

対象は短貸発注（loan-orders）機能です。

### 検証する越境シナリオ（受け入れ条件）

テスト専用データベースに以下を用意します。
- 施設A・施設Bという2つのダミー施設
- ユーザーA（施設Aのみ所属）・ユーザーB（施設Bのみ所属）という2人のダミーユーザー
- 施設Aに紐づく短貸発注データを1件

これに対し、以下がすべてCIで自動確認されることをもって完了とします。

- [ ] ユーザーBが施設Aの短貸発注一覧を取得しようとすると、施設Aのデータが1件も返ってこない（見えない）
- [ ] ユーザーBが施設Aの短貸発注を新規作成しようとすると、拒否される（エラーになる）
- [ ] ユーザーAが自分の施設Aの短貸発注一覧・作成は問題なく成功する（拒否が過剰でないことの確認）
- [ ] 上記すべてがGitHub ActionsのCI上で自動実行され、失敗時はCIが赤くなる

📸 このテストはブラウザ画面を伴わない自動テストのため、スクリーンショット撮影ポイントはありません。

### 対象外（今回はやらないこと）

- loan-orders以外の機能（consumable-orders等）への横展開は次のissueに切り出す
- ブラウザ画面を操作するE2E（Playwright）としての越境確認は行わない（DBレベルの越境チェックを直接確認する方式を採用するため。理由はPart 2参照）

---

## Part 2 — 実装計画（AI用・レビュー不要）

### 技術方式の選定

**採用: 新設のVitest統合テスト設定で、Supabase JS ClientからPostgREST/RPCを直接叩く方式**

検討した選択肢:

| 選択肢 | 概要 | 判定 |
|---|---|---|
| A. 既存vitest(`npm test`)にそのまま追加 | 既存`vitest.config.ts`は`jsdom`環境・DB非接続前提。混在させるとモックテストと統合テストが同一設定内で紛れ、誤って本物のDBに繋ぐテストがモック漏れで壊れるリスク | 不採用 |
| **B. Vitestの新設定(`vitest.integration.config.ts`)+ 新スクリプト(`test:integration`)、supabase-jsで直接PostgREST/RPCを叩く** | Next.jsサーバー起動不要、CIの`supabase start`直後に実行可能で最軽量。issue文言の「直接REST/RPC呼び出し」に最も忠実 | **採用** |
| C. Playwright E2Eの`request` APIコンテキストで直接叩く | Next.js `webServer`起動を待つ必要がありCIが重くなる。E2Eは画面スモーク用途と責務が混ざる | 不採用（将来、画面越しの越境確認をしたくなったら別途検討） |

### 実装セット一覧（依存順）

**セット1: シードヘルパー**
- 新規: `supabase/__tests__/integration/helpers/seed-rls-idor.ts`
  - service role clientで施設A・施設B、ユーザーA・ユーザーB（`auth.admin.createUser`）、`user_facilities`紐付け、施設Aの`loan_orders`1件を作成する関数群をexport
  - 冪等性: 各テスト実行前に一意なメール（例 `rls-idor-user-a-${crypto.randomUUID()}@example.test`）を使うことで`db reset`前提に依存しすぎない設計にする
  - ダミー名を使用（`テスト施設A`/`テスト施設B`等）。実在施設名を入れない（`docs/agents/common.md`のデータ衛生ルール準拠）
  - **本番DB接続防止ガード（必須）**: service role clientを生成する前に、必ず`e2e/env-guard.ts`の`assertTestSupabaseEnv()`を呼び出す。このテストは**実DBに接続する初めてのVitestテスト**であり（既存`admin_rls.test.ts`はファイル文字列を読むだけで接続していない）、ガード漏れはそのまま本番Supabaseへの誤接続リスクに直結するため、既存のPlaywright E2Eと同じ防御を必須で流用する
  - **接続用環境変数名は既存の`e2e/generate-auth-state.ts`（L18-19）と完全に一致させる**: URLは`process.env.NEXT_PUBLIC_SUPABASE_URL`、サービスキーは`process.env.SUPABASE_SERVICE_ROLE_KEY`。`assertTestSupabaseEnv()`は`NEXT_PUBLIC_SUPABASE_URL`という名前を固定で読むため、シードヘルパーが別名の環境変数（例: `SUPABASE_URL`・`TEST_SUPABASE_URL`）を使うと、ガードは「未設定」と誤認して素通りし（`e2e/env-guard.ts` L16-19の仕様）、二重防御のはずが両方とも同時に無効化される。実装時、変数名の一致をコードレビューで必ず確認する
- テスト観点: このファイル自体はテスト対象ではなくテストヘルパーのため、単体テストは不要。セット2の統合テストが通ることで動作確認される

**セット2: RLS/IDOR統合テスト本体**
- 新規: `supabase/__tests__/integration/loan-orders-rls-idor.integration.test.ts`
  - セット1のヘルパーでシード
  - ユーザーBのJWTで`supabase.from('loan_orders').select().eq('facility_id', facilityA.id)` → 0件であることを検証
  - ユーザーBのJWTで`supabase.rpc('create_loan_order_atomic', { p_facility_id: facilityA.id, ... })` → エラー（RAISE EXCEPTIONまたはRLS拒否）を検証
  - ユーザーAのJWTで同様の操作 → 成功することを検証（過剰拒否でないことの確認）
  - 依存: セット1のシードヘルパー
- テスト観点: 上記3パターン（他施設SELECT拒否・他施設RPC拒否・自施設は成功）

**セット3: CI実行基盤**
- 新規: `vitest.integration.config.ts`（既存`vitest.config.ts`を参考に、`environment: 'node'`、`include: ['supabase/__tests__/integration/**/*.integration.test.ts']`、**`globalSetup`に`supabase/__tests__/integration/helpers/global-setup.ts`を指定**）
- 新規: `supabase/__tests__/integration/helpers/global-setup.ts`
  - Vitestの`globalSetup`フックとして、テストファイルが1つでも実行される前に`assertTestSupabaseEnv()`（`e2e/env-guard.ts`からimport）を呼ぶ。ここで例外を投げれば、個々のテストファイルに到達する前にスイート全体が即失敗する
  - セット1（シードヘルパー内のガード呼び出し）との二重防御。片方の呼び出し漏れがあっても本番接続をブロックできるようにする
- 変更: `package.json`（`scripts`に`"test:integration": "vitest run --config vitest.integration.config.ts"`を追加）
- 変更: `.github/workflows/e2e.yml`（`supabase db reset`／`Export local Supabase connection info`ステップの直後、`npm run test:e2e`ステップの前に`npm run test:integration`ステップを新設で追加）
  - **重要（GitHub Actionsのステップ`env:`は他ステップに継承されない）**: 既存の`Run E2E smoke tests`ステップ（e2e.yml L51-60）は`NEXT_PUBLIC_SUPABASE_URL`等を自分の`env:`ブロックだけに閉じて注入している。新設する`Run RLS/IDOR integration tests`ステップにも、**同じ3変数（`NEXT_PUBLIC_SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY`、SELECT検証用に`NEXT_PUBLIC_SUPABASE_ANON_KEY`）を独立した`env:`ブロックとして明示的に複製する**。これを怠ると当該ステップでは環境変数が未設定になり、`assertTestSupabaseEnv()`が「未設定だから素通り」する分岐に入ってしまい、セット1のガードが実質無効化される
  - ローカル実行時は`.env.test`が`NODE_ENV=test`経由で読み込まれる既存の仕組み（`e2e/generate-auth-state.ts`と同じ`loadEnvConfig`パターン）に乗せる
- 依存: セット1・セット2が存在すること（実行対象があって初めて意味を持つ）

**セット4（独立・並列可）: `is_facility_member`のEXECUTE権限の明示化**
- 前提の訂正: マイグレーションファイルに`GRANT EXECUTE`の記述が無いことは事実だが、PostgreSQLは関数作成時にデフォルトで`PUBLIC`へEXECUTE権限を自動付与する。本リポジトリのマイグレーションには`ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE FROM PUBLIC`に相当する記述が存在しない（`grep -rl REVOKE supabase/migrations`で確認済み、ヒットした2ファイルはいずれもテーブル直接アクセスやRPCの個別REVOKEで、デフォルト権限のREVOKEではない）。したがって`is_facility_member`は**現状すでに動作している可能性が高い**。これは「バグ修正」ではなく「他の関数（`create_loan_order_atomic`・`get_admin_status`等）と同様に明示的なGRANTで権限を可視化する」という**明示化**として扱う
- 実装時の手順:
  1. ローカルSupabase起動後、`information_schema.routine_privileges`（または`\df+ is_facility_member`相当）で`authenticated`ロールの実際のEXECUTE権限有無を確認する
  2. 既に権限がある場合も無害なので、明示的な`GRANT EXECUTE ON FUNCTION is_facility_member TO authenticated;`を追加するマイグレーションを新設する（将来誰かが`REVOKE EXECUTE FROM PUBLIC`のような防御的変更を入れた際に、暗黙のPUBLIC権限だけに頼っていたことで静かに壊れるのを防ぐため）
- 触るファイル: 新規マイグレーションファイルのみ（他セットと非依存）

### 並列グループ宣言

- **波1（同時実装可）**: セット1（シードヘルパー）／セット4（GRANT EXECUTE調査・是正）— 互いに別ファイルのみを触るため並列可
- **波2**: セット2（統合テスト本体）— セット1のヘルパーに依存するため波1完了後
- **統合ゲート**: セット3（`package.json`・`vitest.integration.config.ts`・`.github/workflows/e2e.yml`という共有ファイルを触るため、単独実装者が波2完了後にまとめて実施）

### 型・データアクセス層の方針

- 新規コードは既存の`src/lib/supabase/`の型（`Database`型・`asEnum`等のヘルパー）を極力再利用する。ただしテストヘルパーは`supabase/__tests__/`配下に閉じ、本番コードの型定義に影響を与えない
- service role clientの生成は`e2e/generate-auth-state.ts`の`loadEnvConfig`パターン（`NODE_ENV=test`で`.env.test`のみ読込）を踏襲する

---

## Part 3 — 仕様レビュー前セルフチェック（AI用・レビュー不要）

このセルフチェックは主にenum/statusフィールドを新設する仕様が対象だが、本仕様は新しいenum/statusフィールドを導入しないため、該当チェック項目は形式的に確認のみ行う。

- **判定基準の欠落**: 該当なし（新しいenum/statusフィールドを導入しない。テストのpass/fail判定はVitestの標準assert機構に委ねる）
- **下流の反応の欠落**: 該当なし
- **列挙の自己矛盾**: 「対象外」節に列挙したのはloan-orders以外の機能・画面越しE2Eの2点のみで、本文の対象範囲（loan-orders・REST/RPC直接呼び出し）と矛盾しないことを確認済み
- **信号の意味変更**: 既存の`requireFacilityAccess`モックテスト・静的SQLテストは変更せず残す（置き換えではなく追加）。CIの既存`e2e.yml`ジョブの意味（画面スモーク確認）は変えず、新ステップを追加するのみであることを確認済み
