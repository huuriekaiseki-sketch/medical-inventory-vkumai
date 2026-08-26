# 仕様書: get_admin_status RPCの認可バイパス脆弱性修正

## Part 1 — 仕様（人間レビュー用）

### 何ができるようになるか（利用者目線）

現在、ログイン済みの利用者であれば誰でも、他人のアカウントIDを指定するだけで「その人が管理者かどうか」を調べられてしまう不具合があります。この修正により、**自分自身の管理者判定しかできなくなり**、他人の権限情報が外部から分からなくなります。

利用者から見た画面・操作フローそのものは変わりません（ログイン後の管理者メニュー表示・管理画面アクセス制御の見え方は現状と同じ）。今回の変更はサーバー内部の認可チェックの是正であり、UI上の新しい操作は発生しません。

> 📸 スクショ撮影ポイント: なし（UI変更なし。E2E観点はPart 1「受け入れ条件」のAPI/RPC呼び出しレベルの検証で担保する）

### 背景（何が問題だったか）

- `get_admin_status(p_user_id UUID)` というRPC関数が、`SECURITY DEFINER`（RLSをバイパスする特権実行）で動いているにもかかわらず、渡された`p_user_id`が呼び出し本人かどうかを一切確認していなかった。
- 認証済みユーザーなら誰でも呼び出せる権限（`GRANT EXECUTE ... TO authenticated`）が付与されていたため、任意の`p_user_id`を指定して他人の管理者フラグを取得できる状態だった（情報漏えい）。
- さらに調査の結果、TypeScript側の呼び出し元（`src/lib/admin-status.ts`）は既に「パラメータなし」で呼び出す形に変更済みだが、DB側のマイグレーションはパラメータ必須のままであり、**現状は呼び出し自体が引数不一致で失敗する状態**になっている（管理者判定が機能停止するリスクを内包）。

### 修正方針（利用者目線での結果）

1. RPC関数`get_admin_status`をパラメータなしの関数に変更し、内部で`auth.uid()`（呼び出し本人のID）のみを使うようにする。
2. これにより「他人のIDを指定する」余地自体をなくす（パラメータが存在しないので、そもそも他人を指定できない）。
3. TypeScript側の呼び出し・型定義・テストをこの新しいシグネチャに合わせて整合させる。

### 受け入れ条件（チェックリスト）

- [ ] `get_admin_status()`はパラメータを受け取らず、`auth.uid()`で判定した「呼び出し本人の管理者フラグ」と「DB全体の管理者有無フラグ」を返す
- [ ] 他人の`user_id`を指定して管理者判定を取得する手段が存在しない（関数シグネチャレベルで不可能）
- [ ] `anon`ロールには実行権限が付与されない（既存の20260704000002マイグレーションの意図を維持）
- [ ] `authenticated`・`service_role`ロールは実行できる
- [ ] 新しい関数定義は`SET search_path = ''`+`public.`完全修飾になっている（現行のsearch_path硬化慣行に整合）
- [ ] `src/lib/admin-status.ts`の`resolveIsAdmin()`が新しいRPCシグネチャで正しく動作する（自分がadmin→true、他にadminがいれば非adminはfalse、DBにadminが0件ならADMIN_EMAILSフォールバックを使う、という既存の3段階判定ロジックは変更しない）
- [ ] `src/types/database.generated.ts`の`get_admin_status`の型定義がパラメータなしのシグネチャに更新されている
- [ ] `src/lib/__tests__/admin-status.test.ts`のアサーションが新シグネチャ（`db.rpc('get_admin_status')`、引数なし）に整合し、全テストがgreenになる
- [ ] リポジトリに残置されている`supabase/migrations/20260704000001_add_admin_status_rpc.sql.bak`（git管理外の残骸ファイル）を削除する
- [ ] 既存の管理者向け機能（管理画面アクセス制御・admin専用メニュー表示等）が修正後も従来通り動作する（回帰なし）
- [x] DBスキーマ変更を伴うため`npm run test:integration`（RLS/IDOR integrationテスト）をローカル実行し結果を確認する（`docs/agents/rules/db-schema.md`のルールに基づく）— 実行済み: 11ファイル44件全green（実行日時はPart 2セットAのテスト観点参照）

### 対象外（今回のスコープに含まないこと）

- ADMIN_EMAILSフォールバックのロジック自体の変更（Postgres側から環境変数を読めない制約は変わらないため、TS側フォールバックはそのまま維持）
- `requireAdmin()`・`requireFacilityAccess()`・`middleware.ts`など、`resolveIsAdmin()`を呼び出す側の判定フロー自体の変更（呼び出しインターフェースは変えない）
- 他のSECURITY DEFINER関数（`get_distributor_product_price_history`等）の追加監査（既に別マイグレーションで対応済みと調査確認済み）

---

## Part 2 — 実装計画（AI用）

### 実装セット一覧（依存順）

**セットA: DBマイグレーション追加（get_admin_status のシグネチャ変更）**
- 新規ファイル: `supabase/migrations/20260827000001_fix_admin_status_rpc_authz.sql`
- 内容:
  - `CREATE OR REPLACE FUNCTION get_admin_status()`（パラメータなし）
  - 関数本体: `WHERE user_id = p_user_id` → `WHERE user_id = auth.uid()`
  - `SECURITY DEFINER SET search_path = ''`とし、テーブル参照は`public.user_facilities`に完全修飾する（20260804000001_harden_order_rpc_search_path.sqlで確立済みのsearch_path hijacking対策の現行慣行に合わせる。`auth.uid()`は元からスキーマ修飾済み）
  - `GRANT EXECUTE ON FUNCTION get_admin_status() TO authenticated, service_role;`（`anon`は含めない。既存20260704000002の意図を踏襲）
  - 旧シグネチャ`get_admin_status(p_user_id UUID)`が残存しないよう、`DROP FUNCTION IF EXISTS get_admin_status(UUID);`を先頭で実行してから新規作成する（PostgreSQLは引数の型が異なる関数をオーバーロードとして共存させてしまうため、明示的に削除しないと新旧2つの関数が併存し脆弱性が残る）
  - `CREATE OR REPLACE FUNCTION`直後に`REVOKE ALL ON FUNCTION get_admin_status() FROM PUBLIC;`を実行してから`GRANT`する（新規作成される関数オブジェクトにはPostgreSQLのデフォルト仕様でPUBLIC=anon含む全ロールへEXECUTE権限が自動付与されるため、明示的にREVOKEしない限りanonが呼び出せてしまい、受け入れ条件「anonロールには実行権限が付与されない」を満たせない。旧関数への20260704000002のREVOKEは別オブジェクトに対するものでこの新オブジェクトには引き継がれない）
  - ファイル冒頭に脆弱性の内容とauth.uid()採用理由をコメントで明記（既存ファイルのWHYコメント形式踏襲）
- テスト観点:
  - `npm run test:integration`でRLS/IDOR観点の既存スイートを実行し、admin判定関連のテストが通ることを確認
  - 手動確認（可能なら）: 別ユーザーのIDを渡す経路が存在しないことをコードレビューで確認（関数がパラメータを取らないため機械的に保証される）
  - `supabase/migrations/__tests__/admin_status_rpc.test.ts`に本マイグレーション（`20260827000001_fix_admin_status_rpc_authz.sql`）専用の静的検証`describe`ブロックを追加し、以下を回帰テストとして固定する: 旧シグネチャ`get_admin_status(UUID)`の`DROP FUNCTION IF EXISTS`実行、パラメータなし定義＋`auth.uid()`採用、`SECURITY DEFINER`/`SET search_path = ''`＋`public.`完全修飾、`authenticated, service_role`のみへのGRANT（`anon`非包含）
- 触るファイル: `supabase/migrations/20260827000001_fix_admin_status_rpc_authz.sql`（新規）、`supabase/migrations/__tests__/admin_status_rpc.test.ts`（新規describeブロック追加）

**セットB: 残骸ファイル削除**
- `supabase/migrations/20260704000001_add_admin_status_rpc.sql.bak`を削除
- 触るファイル: `supabase/migrations/20260704000001_add_admin_status_rpc.sql.bak`（削除）

**セットC: TS型定義更新**
- `src/types/database.generated.ts`の`get_admin_status`エントリを`Args: Record<PropertyKey, never>`相当（パラメータなし）に更新
  - 本来はSupabase CLIの型生成コマンドで再生成するのが正だが、ローカル生成環境がない場合は手動でAI側が整合するよう編集してよい（既存の他のパラメータなしRPC定義の書式に倣う）
- 触るファイル: `src/types/database.generated.ts`

**セットD: TS呼び出し確認（変更不要の可能性が高い）**
- `src/lib/admin-status.ts`は既に`db.rpc('get_admin_status')`（引数なし）呼び出しに変更済みであることを確認済み。追加の実装作業は不要。ただし念のためセットAのマイグレーション適用後に実装済みコードが型エラーを起こさないか確認する。
- 触るファイル: なし（確認のみ）

**セットE: テスト修正**
- `src/lib/__tests__/admin-status.test.ts`の37行目
  - 変更前: `expect(db.rpc).toHaveBeenCalledWith('get_admin_status', { p_user_id: USER_ID })`
  - 変更後: `expect(db.rpc).toHaveBeenCalledWith('get_admin_status')`
- 触るファイル: `src/lib/__tests__/admin-status.test.ts`、`src/lib/supabase/__tests__/require-facility-access.test.ts`（requireFacilityAccess()経由でresolveIsAdmin()を呼ぶため、同様に旧シグネチャのアサーション・WHYコメントの追従が必要）

### 並列グループ宣言

- **波1（同時実装可・互いに別ファイルのみ触る）**:
  - セットA（`supabase/migrations/20260827000001_fix_admin_status_rpc_authz.sql`新規作成）
  - セットB（`.bak`ファイル削除）
  - セットE（`src/lib/__tests__/admin-status.test.ts`編集）
- **波2（波1完了後・統合ゲートへ）**:
  - セットC（`src/types/database.generated.ts`編集）— セットAのSQL変更内容を正としてAIが手動で型を同期させるため、セットA完了後に着手する（同時実装するとAIが古いシグネチャを見て型を書いてしまうリスクがあるため波を分ける）
- **セットD**は変更なし（確認のみ）のため波に含めない。

### 型・データアクセス層の方針

- RPCの戻り値型（`AdminStatusRow`、`src/lib/admin-status.ts`内で定義）は変更しない（`user_is_admin: boolean`, `db_has_admin: boolean`のまま）。変わるのは呼び出し時の引数の有無のみ。
- `src/types/database.generated.ts`の`Args`フィールドは、他のパラメータなしRPC（例: 同ファイル内の`custom_access_token_hook`のような1引数のもの以外で、引数なしのものがあればそれ）の書式に倣い`Args: Record<PropertyKey, never>`とする。既存コードベース内に引数なしRPCの型定義例があるかセットC着手時に確認し、書式を合わせる。

---

## Part 3 — 仕様レビュー前セルフチェック（AI用）

本仕様は新しい型・enum・statusフィールドを導入するものではなく、既存のRPC関数シグネチャ変更（パラメータの削除）とそれに伴う呼び出し側整合が中心のため、以下の各観点は該当なしと判断した:

- **判定基準の欠落**: 該当なし。新しいenum/statusは導入していない。既存の`user_is_admin`/`db_has_admin`の2値（boolean）の意味・判定ロジックは変更しない。
- **下流の反応の欠落**: 該当なし。`resolveIsAdmin()`を消費する`requireAdmin()`・`middleware.ts`等の下流処理は、関数の戻り値の型・意味が変わらないため、対応の変更は不要（インターフェース互換）。
- **列挙の自己矛盾**: 該当なし。対象/対象外リストはPart 1に記載した通りで、件数の矛盾は生じていない（対象は実装セットA〜E、対象外は3項目のみ）。
- **信号の意味変更**: 該当なし。`WHERE user_id = p_user_id`から`WHERE user_id = auth.uid()`への変更は、既存の呼び出し元（`resolveIsAdmin`）が常に本人IDのみを渡していた実態に処理を合わせるものであり、下流が受け取る`user_is_admin`/`db_has_admin`の意味・型は一切変わらない。

### 追加の注意事項（実装時に見落としやすい点）

- **オーバーロード残存リスク**: `CREATE OR REPLACE FUNCTION get_admin_status()`は引数の型が異なる関数呼び出しとして扱われるため、旧シグネチャ`get_admin_status(p_user_id UUID)`を明示的に`DROP FUNCTION`しない限り、新旧2つの関数がDB上に共存し続け、脆弱性のある旧関数がそのまま呼び出し可能な状態で残ってしまう。セットAで必ず`DROP FUNCTION IF EXISTS`を先に実行すること。
- **PostgREST側のキャッシュ**: 関数シグネチャ変更後、PostgRESTのスキーマキャッシュ更新（NOTIFY pgrst, 'reload schema'等、既存マイグレーションの慣行があればそれに従う）が必要か、既存の類似マイグレーション（例: `20260804000001_harden_order_rpc_search_path.sql`等）を参考に確認する。
