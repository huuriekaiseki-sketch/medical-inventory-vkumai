# SPEC: AAL2要件の統合テストを追加する（issue #684）

## Part 1 — 仕様（★人間がレビューする部分）

### 何ができるようになるか

MFA（多要素認証）を有効化したユーザーが、二段階認証（TOTP）を完了しないまま発注・返却・価格変更などの重要操作を行おうとしたとき、システムが実際に拒否することを、本物のSupabase環境を使って自動的に確認できるようになります。

これは新しい機能を追加するものではなく、**既にDB側に実装されている防御（AAL2要求）が、将来コードが変更されても壊れずに効き続けることを自動チェックする「見張り番」を増やす**作業です。

### 背景（なぜ必要か）

- すでに「二段階認証を完了していないと発注できない」という制限はデータベース側に実装済みです（PR #612, #619, #623）。
- しかし、その制限が正しく効いているかを検証するテストは、対象になっているはずの機能のうち**一部（発注の一種類、価格の一部）にしか存在しません**。
- 今回の調査で、残りの機能（消耗品の発注・器械の貸出発注・貸出返却・消耗品カタログの編集、およびそれぞれの明細）については、制限が正しく効いているかどうかがまだ**一度も自動確認されていない**ことが判明しました。
- 将来誰かが誤ってこの制限を緩めるコード変更をしてしまっても、テストが無ければ気づけません。今回追加するテストが、その「事故に気づく仕組み」になります。

### やること（対象範囲）

以下の操作について、「二段階認証を完了していない状態では拒否され、完了した状態では成功する」ことを確認するテストを追加します。

📸 このタスクはUI変更を伴わないため、スクリーンショット撮影ポイントはありません。テスト実行結果（全件green）が成果物です。

**テーブルへの直接書き込みチェック（画面を経由しない不正な抜け道が塞がっているかの確認）**
- 消耗品発注・器械貸出発注・貸出返却・消耗品カタログ、およびそれぞれの明細データ

**発注操作（RPC）そのもののチェック**
- 症例発注・消耗品発注・貸出返却の3操作（器械貸出発注は既にテスト済みのため対象外）

### 受け入れ条件（チェックリスト）

- [ ] 二段階認証を完了していないセッションで、上記の各操作を試みると拒否される
- [ ] 二段階認証を完了したセッションで、同じ操作を試みると成功する（「常に拒否されているだけ」ではないことの対照確認）
- [ ] 二段階認証そのものを一度も設定していないユーザーは、これまで通り操作できる（既存ユーザーへの影響がないことの回帰確認）
- [ ] 既存の2つのテストファイル（症例発注・貸出発注の既存テスト、施設名更新の対象外確認）が、変更後も壊れずに通り続ける
- [ ] `npm run test:integration` をローカル実行し、全件成功することを確認する

### 影響範囲

- 本番のアプリの挙動・画面には一切変更がありません（テストコードの追加・整理のみ）
- 対象はテスト用のローカルSupabase環境のみで、本番データには触れません

---

## Part 2 — 実装計画（AI用・レビュー不要）

### 現状（Phase1調査で確認済み）

- `supabase/__tests__/integration/require-aal2-in-facility-writer-rls.integration.test.ts`（PR #624）: RLS直接書き込みaal1拒否/aal2成功を`case_orders`・`hospital_prices`のみ確認。`facilities`は対象外の回帰確認あり。
- `supabase/__tests__/integration/require-aal2-for-order-rpcs.integration.test.ts`（PR #612）: RPC呼び出しaal1拒否/aal2成功を`create_loan_order_atomic`のみ確認。
- 両ファイルとも`base32Decode()`/`generateTotp()`（RFC 6238準拠、Node組み込み`crypto`のみ）を独立に重複実装している。
- `supabase/__tests__/integration/helpers/seed-rls-idor.ts`の`createSeededUser`にTOTP関連ロジックはない。

### 実装セット一覧（依存順）

#### Set A: TOTPヘルパーの共通化
- **触るファイル**:
  - 新規: `supabase/__tests__/integration/helpers/mfa-totp.ts`
  - 変更: `supabase/__tests__/integration/require-aal2-in-facility-writer-rls.integration.test.ts`（自前実装を削除し共通ヘルパーに置き換え）
  - 変更: `supabase/__tests__/integration/require-aal2-for-order-rpcs.integration.test.ts`（同上）
- **内容**: `base32Decode`/`generateTotp`/`enrollAndVerifyTotp(client): Promise<{factorId, secret}>`/`signInAtAal1(email, password): Promise<SupabaseClient>`/`stepUpToAal2(client, factorId, secret): Promise<void>`をエクスポートする関数として`mfa-totp.ts`に集約する。既存2ファイルはこれをimportして使う形にリファクタし、**既存のテストケース・アサーションの意味は変更しない**（回帰防止）。
- **テスト観点**: 既存2ファイルの全テストケースが、リファクタ後も同じ結果（pass/fail）になること。`npm run test:integration`をこのセット完了時点で一度実行し、緑を確認してから次に進む。

#### Set B: RLS直接書き込みテストの拡充
- **触るファイル**: `supabase/__tests__/integration/require-aal2-in-facility-writer-rls.integration.test.ts`（Set A完了後、同ファイルへの追記）
- **内容**: 既存の`describe`ブロック内に、以下のテーブルへの直接`.insert()`について「aal1で拒否」「aal2で成功」の対を追加する。
  - `consumable_orders`（列: `facility_id`のみ。他はデフォルト）
  - `loan_orders`（列: `facility_id`, `procedure_name`, `maker`）
  - `loan_returns`（列: `facility_id`, `return_datetime`。`loan_order_id`はNULL許容なので省略可）
  - `consumables`（列: `facility_id`, `jan`, `name`, `purpose`。jan一意制約に注意し`runId`でユニーク化）
  - 明細4テーブル（親レコードをservice_roleで先に作成してから、明細への直接insertでaal1拒否/aal2成功を確認）:
    - `case_order_items`（親`case_orders`必要。列: `case_order_id`, `jan`, `lot`, `ubd`, `quantity`）
    - `consumable_order_items`（親`consumable_orders`と`consumables`必要。列: `consumable_order_id`, `consumable_id`, `quantity`）
    - `loan_order_items`（親`loan_orders`必要。列: `loan_order_id`, `jan`, `name`, `quantity`）
    - `loan_return_items`（親`loan_returns`必要。列: `loan_return_id`, `jan`, `lot`, `ubd`, `quantity`）
- **テスト観点**: 各テーブルにつき最低2ケース（aal1拒否／aal2成功）。明細テーブルの親レコードはservice_roleクライアントで作成し、RLSの影響を受けないようにする（既存の`hospital_prices`テストの`products`/`categories`/`distributor_products`作成パターンを踏襲）。

#### Set C: RPC呼び出しテストの拡充
- **触るファイル**: `supabase/__tests__/integration/require-aal2-for-order-rpcs.integration.test.ts`（Set A完了後、同ファイルへの追記）
- **内容**: 既存の`describe`ブロックと同じ構造で、以下3RPCについて「MFA未登録は成功（回帰なし）」「aal1は拒否（forbidden: aal2 required）」「aal2は成功」の3ケースを追加する。
  - `create_case_order_atomic(p_facility_id, p_case_datetime, p_procedure_name, p_patient_id, p_patient_initials, p_gender, p_doctor_name, p_items)`
  - `create_consumable_order_atomic(p_facility_id, p_items)`（`p_items`は空配列`[]`でよい）
  - `create_loan_return_atomic(p_header, p_items)`（`p_header`は`{facility_id, return_datetime}`のJSONB。`p_items`は空配列でよい）
- **テスト観点**: 既存の`create_loan_order_atomic`向けテストと同一パターン（enroll→aal1拒否→aal2成功）。3RPCそれぞれ独立した`describe`または既存の1つの`describe`内にテストケースを追加する形でよい（新規ユーザー・施設を都度作るか共有するかは既存の`beforeAll`構造に合わせる）。

### 並列グループ宣言

- **波1（単独）**: Set A — 他の2セットの前提となる共通ヘルパー抽出。単独で先行実装し、`npm run test:integration`で既存回帰がないことを確認してから波2へ進む。
- **波2（並列可）**: Set B と Set C — 互いに別ファイル（`require-aal2-in-facility-writer-rls...`と`require-aal2-for-order-rpcs...`）のみを触るため同時実装可能。どちらもSet Aが作る`mfa-totp.ts`をimportするのみで、Set Aのファイル自体は編集しない。
- **統合ゲート**: 波2完了後、両ファイルを合わせて`npm run test:integration`を実行し、全件成功を確認する。DBスキーマ変更は伴わないため、`docs/agents/db-schema.md`の直接DDL実行系ルールは非該当（migrationファイル自体の変更なし）。

### 型・データアクセス層の方針

- 新規のプロダクションコード（`src/`配下）・migrationの変更は無い。純粋にテストコードの追加・リファクタのみ。
- `mfa-totp.ts`の関数シグネチャ:
  ```ts
  export function generateTotp(secretBase32: string): string
  export async function enrollAndVerifyTotp(client: SupabaseClient): Promise<{ factorId: string; secret: string }>
  export async function signInAtAal1(client: SupabaseClient, email: string, password: string): Promise<void>
  export async function stepUpToAal2(client: SupabaseClient, factorId: string, secret: string): Promise<void>
  ```
  （`base32Decode`は`generateTotp`内部のプライベート実装のままでよく、exportは不要）

---

## Part 3 — 仕様レビュー前セルフチェック（AI用・レビュー不要）

- **判定基準の欠落**: 新しい型・enum・statusフィールドは導入しないため非該当。
- **下流の反応の欠落**: 非該当（既存の`has_aal2()`の判定ロジックはPart2で一切変更しない。テストは既存実装の外部観測のみ）。
- **列挙の自己矛盾**: 対象テーブル一覧を数え直した — 発注/返却4テーブル(consumable_orders, case_orders, loan_orders, loan_returns) + 価格・カタログ2テーブル(hospital_prices, consumables) + 明細4テーブル(case_order_items, consumable_order_items, loan_order_items, loan_return_items) = 計10テーブル。うち`case_orders`/`hospital_prices`は既存テスト済みのため、Set Bで新規追加するのは残り8テーブル（consumable_orders, loan_orders, loan_returns, consumables + 明細4件）。migrationファイル（20260806000002_...sql）内のポリシー定義10件と一致することを確認済み。RPCは4件のうちcreate_loan_order_atomicが既存テスト済み、Set Cで追加するのは残り3件。migrationファイル（20260806000001_...sql）内の関数定義4件と一致することを確認済み。
- **信号の意味変更**: 既存の判定ロジック（`has_aal2()`のSQL、`aal1`/`aal2`文字列比較）は一切変更しない。テスト追加のみ。
