# 仕様書ドラフト: アクセス拒否記録が黙って消える3経路を直す

## Part 1 — 仕様（人間レビュー用）

### 何ができるようになるか（利用者目線）

このシステムは、権限のない操作が弾かれた（アクセス拒否）とき、その記録を `access_denials`
テーブルに残して「誰が・いつ・どの境界で弾かれたか」を後から追跡できるようにしている。

今回直すのは、**その記録の仕組み自体が壊れていても、誰にも気づかれない**という問題。

- 環境変数（Supabaseへの接続情報）が設定されていない実行環境では、記録機能が最初から
  動いていない。これは単体テストなど意図的な環境では正常だが、本番環境で万一同じ状態に
  なった場合、誰も気づけない。
- 記録処理の途中で想定外の例外が起きた場合、その例外はログに出ずに消えている。
- ログイン画面の「保険」のエラー処理も同様に、例外を無言で握りつぶしている。

この修正により、上記の状況が起きたときに**サーバーログに記録が残るようになる**。
これは運用者・開発者が後から調査するためのログ出力の追加であり、利用者（ログイン画面を
使う人）が画面上で見る内容・操作感・拒否そのものの動作（弾かれる/弾かれない）は
一切変わらない。

**UI変更の有無**: 画面の見た目・操作フロー・処理中表示・バリデーション表示タイミングの
変更はゼロ。すべてサーバー内部のログ出力（開発者向け）の追加のみ。したがって
Part 1 に画面モックは不要（design スキルの対象外）。

### 操作の流れ

利用者側の操作フローに変化はない。ログイン画面（`/login`）を開く → 通常通り表示される、
という挙動は今回の修正前後で同一。

### 受け入れ条件（チェックリスト）

- [ ] `SUPABASE_SERVICE_ROLE_KEY` または `NEXT_PUBLIC_SUPABASE_URL` が未設定の状態で
      `recordAccessDenial` が最初に呼ばれたとき、警告ログが1回だけ出力される
      （同一プロセス内で複数回呼ばれても2回目以降は出力しない）
- [ ] 上記の場合でも、`recordAccessDenial` は例外を投げず正常にreturnする
      （拒否そのものの fail-closed 動作、記録は fail-open という既存方針は変えない）
- [ ] `recordAccessDenial` 内の外側 `catch` で例外を捕まえた場合、`logServerError` で
      ログに残る（現状は無言で握りつぶされている）
- [ ] `src/app/login/page.tsx` の72行目付近の保険用 `catch` で例外を捕まえた場合、
      `logServerError` でログに残る
- [ ] 既存のテスト（`access-denial.test.ts`）が green のまま。特に
      「環境変数不在時は何も起きずreturnする」という既存の前提テストを、
      「初回だけ警告ログが出る」という新しい仕様に合わせて更新する
- [ ] 記録そのもの（DB書き込み）の成功/失敗の挙動、および拒否判定（アクセスを弾く/弾かない）
      の挙動は一切変更しない

---

## Part 2 — 実装計画（AI用）

### 実装セット一覧（依存順）

**セットA: `access-denial.ts` の修正**
- 対象ファイル: `src/lib/security/access-denial.ts`
- 内容:
  1. `serviceRoleClient()` 内、`cached = url && key ? ... : null` の分岐で、
     `null` になった**最初の1回だけ** 共有ヘルパー（下記参照）を呼んで警告を出す。
     - WHY設計判断: env未設定時の初回警告を共有関数に一本化し、3ファイル間での
       ロジック重複を避けるため。
  2. 82-118行目の外側 `catch {}`（114-117行目）に `logServerError('record_access_denial_unexpected', error)`
     相当を追加する（`catch {}` → `catch (error) { logServerError(...) }`）。
     113行目の既存の `if (error) logServerError('record_access_denial', error)`（PostgREST戻り値の
     エラー）とは別経路・別contextなので、区別できるcontext文字列にする。
- テスト観点:
  - 環境変数unset時、1回目の呼び出しで警告ログが出ることを確認
  - 同一モジュールインスタンス内で2回目以降呼んでも警告ログが重複しないことを確認
  - 外側catchが拾う例外（`routeFromHeaders`失敗、`withJudgmentTimeout`実行時の例外等）で
    `logServerError`が呼ばれることを確認
  - いずれの場合も `recordAccessDenial` が例外を投げずreturnすることを確認（fail-open維持）
- 型: 変更なし（`AccessDenial`, `DenialGuard`, `DenialReason` は既存のまま）
- データアクセス層: 変更なし（DB書き込み・RPCの呼び出し方は既存のまま）

**セットB: `login/page.tsx` の保険catch修正**
- 対象ファイル: `src/app/login/page.tsx`
- 内容: 72-74行目の `catch { // WHY: ... }` に `catch (error) { logServerError('proxy_admin_denial_record_failed', error) }` を追加。
  既存の32-38, 43-48, 53-61行目の他のcatchと同じパターンに揃える。
- テスト観点:
  - `recordAccessDenial`がthrowするケース（モックで例外を投げさせる）で`logServerError`が
    呼ばれることを確認
  - 既存の正常系（記録成功、`recordAccessDenial`が例外を投げない）テストに影響がないことを確認
- 型: 変更なし
- データアクセス層: 変更なし（このcatchはUI表示に影響しないServer Component側のロジック）

**セットC: `hidden-row-denial.ts` の修正**
- 対象ファイル: `src/lib/security/hidden-row-denial.ts`
- 内容: `serviceRoleClient()` の実装が `access-denial.ts` と同一のコピペのため、同じ欠陥を持つ。
  セットAと同じパターンを適用する：
  1. env未設定時に共有ヘルパーを呼ぶ（セットAと共通の警告ロジック）
  2. 外側catchに `logServerError('hidden_row_denial_unexpected', error)` を追加
- テスト観点:
  - セットAと同じ観点。ただしファイル固有のcontext文字列（`hidden_row_denial_unexpected`）で
    セットAと区別できるようにする
- 型: 変更なし
- データアクセス層: 変更なし

**共有ヘルパー関数**
- 場所: `src/lib/security/` 配下に新規作成（ファイル名は実装時に決定）
- 用途: env未設定時の初回警告を一本化。モジュールスコープのフラグにより
  「プロセス起動〜デプロイまで1回」、テスト時は「テストケースごとに1回」を実現
- 呼び元: セットAとセットCの `serviceRoleClient()` から呼び出す

### 並列グループ宣言

- セットA（`src/lib/security/access-denial.ts` + `src/lib/security/__tests__/access-denial.test.ts`）
- セットB（`src/app/login/page.tsx` + 関連テスト、ファイル名は実装時に確認）
- セットC（`src/lib/security/hidden-row-denial.ts` + 関連テスト）
- 共有ヘルパー（セットAとセットCから依存されるため、最初に実装 or 共有グループとして
  セットAとセットCと並列実装可）

セットA・セットB・セットCは触るファイルが完全に重複しないため、**同一の波（3つ同時実装可）**とする。
統合ゲートでは全3セットのテストを通しで実行し、既存のfail-open系テスト
（`check-fail-open.test.sh`等）が全変更後も green であることを確認する。

---

## Part 3 — 仕様レビュー前セルフチェック（AI用）

- UI変更なし（画面の見た目・操作感の変更ゼロ、サーバー内部のログ追加のみ）→ design スキルの
  モック作成は対象外。Before/After比較も不要。
- 新しい型・enum・statusフィールドの追加なし（既存の `DenialGuard`/`DenialReason` は変更しない）
  → 判定基準・下流の反応・列挙の自己矛盾チェックは対象外。
- 既存の判定ロジック（`if (!db) return`、`catch {}`）への変更はログ出力の追加のみで、
  戻り値・例外の有無・呼び出し元から見た挙動（fail-open/fail-closed）は変えない
  → 信号の意味変更なし。
