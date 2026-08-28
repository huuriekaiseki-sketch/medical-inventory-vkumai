# 仕様書: 短貸返却(loan_return)の二重登録を防止する(issue #675)

## Part 1 — 仕様（人間レビュー用）

### 何ができるようになるか（利用者目線）

同じ短貸発注(loan_order)に対して返却登録を誤って2回行おうとした場合（ダブルクリック・ネットワーク再送・複数タブでの同時操作など）、2件目の登録がエラーとして拒否されるようになります。エラー時には生のDBエラーではなく「既に返却済みです」等の分かりやすいメッセージが表示されます。

### 背景（何が問題だったか）

`create_loan_return_atomic` RPC（`supabase/migrations/20260726120000_add_loan_order_id_to_loan_return_atomic_rpc.sql`）は `loan_returns.loan_order_id` を保存するが、この列にUNIQUE制約が無い。そのため同じ `loan_order_id` に対して返却登録を2回実行すると、`loan_returns` に重複行が作られてしまう。

実測（`src/app/facilities/[id]/loan-returns/new/page.tsx`）で確認した現状:
- 返却フォームの「対象の短貸発注」プルダウンは、`unreturned`（未返却）な `loan_order` のみを選択肢に表示する（`src/lib/orders/repository.ts:171` の `unreturned = status === 'submitted' && returns.length === 0`）ため、**画面を開いた時点で返却済みのものは選択肢に出ない**。
- 送信ボタンは `disabled={submitting}` により、送信中は再クリックできない。

したがって「同一ブラウザでの単純な連打」は既存UIで概ね防がれているが、以下のケースはすり抜ける:
- 2つのタブ/ウィンドウで同じ画面を開いたまま片方が先に返却登録し、もう片方が（未返却のまま見えている）同じ `loan_order` を選んで送信する
- ネットワーク再送（クライアントの二重fetch等）

これらのケースは正規の操作からでも発生しうるため、**DB制約による最終防御**が必要（issue本文が参照するRiffGearの知見「DB制約は認可ではない。権限のある処理からでも、不正なデータ状態そのものを保存させない最後のルール」）。

### 対象外（今回のスコープに含まないこと）

- `loan_order_id` を指定しない返却（従来通り無制限に複数回登録できる。対象外の値なのでUNIQUE制約の対象にしない）
- 「返却済み」ラベルをプルダウン内に表示する対応（現状は選択肢から除外する設計になっており、これ自体は今回のスコープでは変更しない。除外の代わりにラベル表示へ変更する要望は別issueとする）
- 返却の取り消し・再オープン機能

### 受け入れ条件（チェックリスト）

- [ ] `loan_returns.loan_order_id` に、NULLを除外した部分UNIQUEインデックスが追加されている（`loan_order_id IS NOT NULL` の行のみ一意）
- [ ] 同一 `loan_order_id` を指定して `create_loan_return_atomic` RPCを2回連続で呼ぶと、1回目は成功、2回目はエラーになる
- [ ] 2回目のエラーがAPIレスポンスとして返る際、生のPostgresエラー（制約名・テーブル名を含む文字列）ではなく「既に返却済みです」等のクライアント向けメッセージになっており、HTTPステータスは400（クライアント起因）である
- [ ] `loan_order_id` を指定しない返却（対象を選ばない返却登録）は、従来通り何回でも登録できる（回帰なし）
- [ ] 同じ `loan_order_id` へ返却登録を2件同時送信した場合、成功1件・失敗1件になり、`loan_returns` に対応する行が1件だけ残る（同時実行時もDB制約で最終的に1件に収束する）
- [ ] 既存の `add_loan_order_id_to_loan_return_atomic_rpc.test.ts`（静的SQL検証）が引き続きgreenである
- [ ] `supabase/__tests__/integration/loan-returns-rls-idor.integration.test.ts` 等の既存integrationテストが引き続きgreenである
- [x] DBスキーマ変更を伴うため `npm run test:integration`（RLS/IDOR integrationテスト）をローカル実行し結果を確認する（`.claude/rules/db-schema.md`のルール）— 実装完了後に実行し、結果をPRの引き継ぎメモに記載する

---

## Part 2 — 実装計画（AI用）

### 実装セット一覧（依存順）

**セットA: DB — UNIQUE制約追加（独立・最優先）**
- 新規マイグレーション（例: `supabase/migrations/2026xxxxxxxxxx_add_unique_loan_order_id_to_loan_returns.sql`）
  ```sql
  CREATE UNIQUE INDEX loan_returns_loan_order_id_unique
    ON loan_returns (loan_order_id)
    WHERE loan_order_id IS NOT NULL;
  ```
  （`loan_order_id` はNULL許容のFKであり、大多数の既存行はNULLのまま。部分インデックスでNULLを除外しないと「NULL同士は不一致」というPostgresのUNIQUE制約の挙動に依存する必要がなくなり意図が明確になる）
- publicスキーマのテーブル追加/削除ではない（インデックス追加のみ）ため `refresh_schema_baseline_snapshot` の呼び出しは不要（`.claude/rules/db-schema.md`の対象は「テーブルを追加/削除するmigration」）
- テスト観点: `supabase/migrations/__tests__/` に静的SQL検証テストを追加し、`CREATE UNIQUE INDEX ... WHERE loan_order_id IS NOT NULL` を含むことを確認する（`add_loan_order_id_to_loan_return_atomic_rpc.test.ts`と同じ静的検証パターン）
- 触るファイル: 新規migrationファイル1つ、対応する`__tests__/*.test.ts`1つ

**セットB: ロジック/API — UNIQUE制約違反(23505)のエラー翻訳（セットA完了後）**
- `src/lib/loan-returns/repository.ts` の `createLoanReturn` 内、`db.rpc('create_loan_return_atomic', ...)` のエラーハンドリング（現在 `if (error) throw new Error(error.message)` の箇所、107-137行目付近）に、`consumables/repository.ts:53` と同じパターンで分岐を追加する:
  ```ts
  if (error) {
    if (error.code === '23505') throw new ClientVisibleError('この短貸発注は既に返却登録されています')
    throw new Error(error.message)
  }
  ```
- `src/app/api/loan-returns/route.ts` のPOSTハンドラのcatch節を、`consumables/route.ts:62` と同じ `instanceof ClientVisibleError` チェックに統一する（現状は `error.message === LOAN_ORDER_NOT_FOUND_ERROR` という文字列比較のみで、`ClientVisibleError` の型チェックをしていない）:
  ```ts
  } catch (error) {
    if (error instanceof ClientVisibleError) return apiError(error.message, 400)
    return apiError(toClientErrorMessage(error, '返却に失敗しました'))
  }
  ```
  この変更により、既存の `LOAN_ORDER_NOT_FOUND_ERROR`（`ClientVisibleError`として投げられている）と、新規追加する重複エラーの両方が同じ経路で400として扱われる（`LOAN_ORDER_NOT_FOUND_ERROR`という個別のimport・文字列比較は不要になり削除する）
- テスト観点（unit）: `src/lib/loan-returns/__tests__/repository.test.ts` に、RPCエラーの `code` が `'23505'` のときに `ClientVisibleError('この短貸発注は既に返却登録されています')` がthrowされることを検証するテストを追加。`src/app/api/loan-returns/__tests__/route.test.ts` に、`ClientVisibleError` がthrowされた場合にPOSTが400+当該メッセージを返すことを検証するテストを追加
- 触るファイル: `src/lib/loan-returns/repository.ts`, `src/app/api/loan-returns/route.ts`, 上記2つの `__tests__/*.test.ts`

**セットC: UI — 二重送信の追加防御確認（独立・小規模、既存実装の確認が主）**
- 実測の通り、送信ボタンは既に `disabled={submitting}` で二重送信防止済み、プルダウンは既に未返却のもの（`unreturned`）のみを表示している。**この2点についてはコード変更不要**
- 追加対応: セットBで新設したエラーメッセージ（「この短貸発注は既に返却登録されています」）が、`src/app/facilities/[id]/loan-returns/new/page.tsx` の `handleSubmit` 内の既存エラー表示（`error` state、87行目）にそのまま表示されることを確認する（コードの変更は不要。API側が `{ error: string }` 形式で返す既存の仕組みに乗るため）
- テスト観点（E2E, 任意）: 2つのタブ/ウィンドウで同一 `loan_order` に対して返却登録を試み、片方が成功しもう片方がエラーメッセージ表示になることを確認する。E2Eでの多重タブ再現が難しい場合は、integrationテスト（セットD）の同時実行テストで代替してよい
- 触るファイル: なし（確認のみ）。E2Eを追加する場合は `e2e/` 配下に1ファイル追加

**セットD: テスト — RLS/integration・同時実行テスト（セットA完了後、B/Cと並行可）**
- `supabase/__tests__/integration/loan-returns-rls-idor.integration.test.ts` に以下を追加:
  - 同一 `loan_order_id` を指定して `create_loan_return_atomic` を2回連続で呼び、1回目success・2回目errorになることを確認するテスト
  - 同一 `loan_order_id` を指定して `Promise.all` で2件同時に `create_loan_return_atomic` を呼び、`results.filter(r => r.error === null).length === 1` かつ、その後 `loan_returns` を `loan_order_id` で絞り込むと1件だけ返ることを確認するテスト（`e2e-test-hygiene.md`のテストデータ衛生ルールに従うこと）
- テスト観点: 上記2件（連続呼び出し・同時呼び出し）
- 触るファイル: `supabase/__tests__/integration/loan-returns-rls-idor.integration.test.ts`（既存ファイルへの追記）

### 並列グループ宣言

- **波1（同時実装可）**: セットA（DBマイグレーション）
- **波2（セットA完了後、同時実装可）**: セットB（ロジック/API） / セットD（integrationテスト）
- **波3（セットB完了後）**: セットC（UI確認・任意のE2E追加）
- **統合ゲート**: 全セット完了後、`npm test` と `npm run test:integration` を実行しgreenであることを確認する

---

## Part 3 — 仕様レビュー前セルフチェック（AI用）

- 新しいenum/status型の導入なし
- 列挙・包含/除外リストなし（UNIQUE制約はNULLを除外する部分インデックスのみ）
- 判定基準の明記: `loan_order_id IS NOT NULL` の行のみを対象にUNIQUE制約を課す。NULL（対象を選ばない返却）は制約対象外で従来通り複数回許可
- 信号の意味変更に該当する箇所: なし（既存の `unreturned` 判定・エラーレスポンス形式 `{ error: string }` は変更しない。エラーメッセージの翻訳経路を `instanceof ClientVisibleError` に統一する変更のみで、既存の `LOAN_ORDER_NOT_FOUND_ERROR` の外部向け挙動（メッセージ文言・400ステータス）は変わらない）
