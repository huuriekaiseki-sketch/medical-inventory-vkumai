# issue #793 仕様書: serviceRoleClient() の無音失敗の解消と共有ヘルパー化

> AIDD deep ルート（`wf_45c3967f-aca`、67 体・293 万トークン）の調査・検証結果を反映した確定版。
> **停止①（人間レビュー）待ち。** 承認を得るまで実装に着手しない。

## Part 1 — 仕様（人間レビュー用）

### 何ができるようになるか

運用者（開発者・インシデント対応者）向けの内部品質改善で、**エンドユーザーの画面挙動は変わらない**。

いま `NEXT_PUBLIC_SUPABASE_URL` または `SUPABASE_SERVICE_ROLE_KEY` が未設定の環境では、
拒否記録・特権操作記録・レート制限記録が**ログを一切出さずに落ちる**。
本番の設定漏れでも同じ経路を通るので、「監査記録が全部消えている」ことに誰も気づけない。

この変更で、その環境では**初回だけ警告ログが出る**ようになる。

### 調査で分かった、issue 本文との差（重要）

issue #793 は「`hidden-row-denial.ts` の 2 経路」と書いているが、実コードを読むと範囲が違った。

| issue の記述 | 実態 |
| --- | --- |
| 無音経路は `hidden-row-denial.ts` に 2 つ | **無音なのは env 未設定時の 1 経路だけ**。外側 catch には既に `logServerError('hidden_row_denial_skip', error)` がある |
| コピペは 2 ファイル | **4 ファイル**（`access-denial` / `hidden-row-denial` / `privileged-operation` / `rate-limit`）。`access-denial.ts` だけが警告ログを持つ |
| — | `route.ts` の fire-and-forget は**存在しない**。`facilities/[id]:29` / `hospital-prices/[id]:27` / `admin/users:113,151` は**全て `await` 済み**（実測）。当初の Sweep 指摘は誤り |
| — | `resetPrivilegedOperationClientForTests` / `resetRateLimitClientForTests` は**デッドコード**。定義行以外に 1 件もヒットせず、テストは `vi.resetModules()` を使っている（実測） |

### 受け入れ条件

- [ ] `hidden-row-denial.ts` / `privileged-operation.ts` / `rate-limit.ts` の 3 ファイルで、env 未設定時に**初回だけ** `logServerError` が出る
  - logKey: `hidden_row_denial_client_unavailable` / `privileged_operation_client_unavailable` / `rate_limit_client_unavailable`
  - `access-denial.ts` の既存キー `access_denial_client_unavailable` は**変えない**（運用ログの互換）
- [ ] 4 ファイルの `serviceRoleClient()` が共有ヘルパー 1 本に置き換わり、`grep -rn "let cached" src/lib/security/` が **0 件**になる
- [ ] 上記 grep を**構造テストとして機械検査する**（目視確認にしない）
- [ ] 拒否そのものの fail-closed と、記録の fail-open 方針は**変えない**
- [ ] DB / RLS / RPC（`record_access_denial` 等）は**変更しない**

### 変えないもの（意図的に）

- **キャッシュは呼び出し元ごとに独立させる**（プロセス全体のグローバル Singleton にしない）。
  理由: 呼び出し元が増えたときに既存の生存期間とテスト分離へ影響を与えないため。
  グローバル 1 個にすると「初回だけ警告」の粒度がプロセス全体になり、**先に呼ばれた方の logKey でしか警告が出ず、テストが実行順で揺れる**。
- RPC のバッチング・SELECT 列の絞り込みなどの最適化は**本 issue では扱わない**（配管の共通化とは独立した話）。

## Part 2 — 実装計画

### セット1: 共有ヘルパー新設（直列・全セットの前提）

- 新規 `src/lib/security/service-role-client.ts`
  ```ts
  export function createServiceRoleClientAccessor(logKey: string): {
    get(): ReturnType<typeof createClient<Database>> | null
    resetForTests(): void
  }
  ```
- **初版は `access-denial.ts` の現行コードのコピーとして作り、新規ロジックを書かない**（挙動差分ゼロを保証し、レビューを「コピペ一致確認」で済ませる）
- キャッシュはファクトリが返すクロージャ内の変数（モジュールのトップレベル変数にしない）
- WHY コメント: 使い回す理由（fetch 設定の再構築コストで統合テストが 3 倍になった実測）／警告が初回だけになる理由（`cached !== undefined` の早期 return で到達が 1 回に限られる）／fail-open と fail-closed の境界
- テスト `service-role-client.test.ts`（新規）: env 未設定→null かつ `logServerError(logKey)` が 1 回だけ／env 設定済み→`createClient` が呼ばれキャッシュされる／`resetForTests()` 後は再評価される

### セット2: `access-denial.ts` の移行（A1）

- ローカル実装を削除し `createServiceRoleClientAccessor('access_denial_client_unavailable')` を使う
- 既存テスト（`access-denial.test.ts:111-128`）が**そのまま通る**ことを確認する

### セット3: 残り 3 ファイルの移行（A2 / A3 / A4）

- **着手条件（機械判定）**: `service-role-client.test.ts` と `access-denial.test.ts` が**両方 green** であること
- 各ファイルのローカル実装を削除し、固有の logKey で共有ヘルパーを使う
- 各 `__tests__/*.test.ts` に「env 未設定→初回だけ警告」を追加する。形は `access-denial.test.ts:111-128` と同型:
  `loadModule()`（= `vi.resetModules()` + 動的 import）／`vi.spyOn(console, 'error')` で**呼び出し回数**と**文字列に logKey が含まれること**／2 回目は呼ばれないこと

### セット4: 重複が消えたことの機械検査

- `grep -rn "let cached" src/lib/security/` が 0 件であることを `npm test` 配下の構造テスト 1 本として追加する
- **TypeScript のビルド通過だけでは「重複実装が本当に消えたか」は検知できない**ので、型検査に委ねない

### 並列グループ宣言

- 直列: セット1 → （A1）→ A2 / A3 / A4 は並列 → セット4
- A1: `access-denial.ts` + その `__tests__`
- A2: `hidden-row-denial.ts` + その `__tests__`
- A3: `privileged-operation.ts` + その `__tests__`
- A4: `rate-limit.ts` + その `__tests__`

### 触らないもの

- `supabase/migrations/`、`src/lib/supabase/`、`src/app/**/route.ts`
- 各呼び出し元のビジネスロジック（RPC のパラメータ・タイムアウト・エラーハンドリング）

## 停止①で決まったこと（2026-09-19 承認）

1. **範囲は 4 ファイル**（`access-denial` / `hidden-row-denial` / `privileged-operation` / `rate-limit`）。
   issue 本文の 2 ファイルではなく、実測で見つかった同じ穴をまとめて塞ぐ
2. **reset 関数は「使われているものだけ残す」。**
   承認時は「両方デッドコード」という前提だったが、**その判断は誤りだった**——
   deep ルートの調査が `grep ... src` で確かめており、`supabase/__tests__/` を見ていなかった（C-040）。
   実装中に型検査が捕まえた。
   - `resetPrivilegedOperationClientForTests` … **残す**。
     `privileged-operations-rls-idor.integration.test.ts:272,279` が呼んでいる。
     統合テストは `vi.resetModules()` を使わず `import()` するので、キャッシュを捨てる口が要る
   - `resetRateLimitClientForTests` … **消す**。リポジトリ全体で呼び出し元ゼロを再実測した
   - 共有ヘルパーは `resetForTests()` を 1 本持ち、残す側だけが 1 行で re-export する
3. **`onUnavailable` フックは作らない。** 使う当てのない予約引数は過剰実装
4. **logKey は各ファイルに直書きする。** 呼び出し側を見れば分かる形を優先する
5. **fire-and-forget の別 issue 化は不要。** 実測で全て `await` 済みだった（当初の Sweep 指摘が誤り）
