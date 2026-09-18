# 部分成功の棚卸し（M-xxx）

「DB は更新されたが応答が届かない」「1 段目は成功し 2 段目だけ失敗」のような **中間状態**が、
この製品のどの書き込み経路にあり、利用者に何が見え、再試行すると正しい終端に着くかを一覧にしたもの
（issue #757 の 38）。冪等性（P-053）と同時実行（P-052）が「同じ操作を 2 回」を扱うのに対し、
ここは「1 つの操作が途中で止まる」を扱う。原則は 2 つ: **1 操作は 1 トランザクション**（中間状態を
作らない）、作れないなら **再試行で収束する**（利用者がもう一度押せば直る）。

## 更新ルール

- 列は固定 7 列: ID / 経路（段の順） / 途中で止まる形 / 利用者に見えること / 再試行の約束 / 守るテスト / 状態。列の中に `|` を書かない。
- ID は `M-` + 3 桁。区分ごとに 10 刻み（DB 内の複数段 00x / DB と応答 01x / 認証・招待 02x / 画面 03x / 夜間・自動処理 04x）。欠番は詰めない。
- 状態は 4 語のみ:
  - 原子的: 全段が 1 トランザクション（RPC・トリガー・CASCADE）で、中間状態が存在しない。守るテストが必須
  - 収束する: 中間状態はあるが、もう一度同じ操作をすると正しい終端に着く（行が増えない・古い残骸が掃除される）。守るテストが必須
  - 中間状態あり: 再試行で収束しない、または人の手当てが要る。`#757-N` を必ず書く
  - 未確認: 途中で止めて確かめていない。`#757-N` を必ず書く
- 「守るテスト」列はバッククォートでパスを書く。無い行は `未`。`scripts/lib/check-catalog.mjs`（登録簿の `partial-success`）
  （CI `hooks-test`）が列数・ID・状態・パスの実在・原子的と収束するのテスト有無・#757-N を検査する。
- **更新の引き金**: 書き込み経路の追加（route・RPC・トリガー・メール送信・外部連携・Storage）、
  「1 リクエストで 2 つ以上の表を書く」コードの追加、在庫の減算・締めなど集計を伴う機能の追加。

## 一覧

### DB 内の複数段（00x）

| ID | 経路（段の順） | 途中で止まる形 | 利用者に見えること | 再試行の約束 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| M-001 | 発注 3 種の作成: ヘッダ INSERT → 明細 INSERT（`create_*_order_atomic`） | 明細で失敗するとヘッダも残らない（1 RPC = 1 トランザクション） | エラー 1 文。発注一覧に半端な発注は出ない | 同じ内容を送り直す。鍵が同じなら既存行を返す（M-010） | `supabase/__tests__/integration/order-idempotency.integration.test.ts`、`supabase/__tests__/integration/audit-log-rls-idor.integration.test.ts` | 原子的 |
| M-002 | 返却登録: `loan_returns` INSERT → `loan_return_items` INSERT（`create_loan_return_atomic`） | 同上。同じ短貸発注への 2 回目は 23505 で全体が拒否される（P-050） | エラー 1 文 | 同上 | `supabase/__tests__/integration/order-idempotency.integration.test.ts`、`supabase/__tests__/integration/loan-returns-rls-idor.integration.test.ts` | 原子的 |
| M-003 | 施設別価格の更新 → 価格履歴の追記（`trg_hospital_prices_price_history`、同一トランザクション） | 履歴だけ残らない・価格だけ変わる、は起きない | 保存後に履歴が 1 件増えて見える | 楽観ロック（P-052）で競合なら拒否。読み直して再保存 | `supabase/__tests__/integration/hospital-prices-concurrency.integration.test.ts`、`supabase/__tests__/integration/price-histories-rls-idor.integration.test.ts` | 原子的 |
| M-004 | 全 16 表の変更 → `audit_log` 追記（AFTER 行トリガー、同一トランザクション） | 監査行だけ遅れる・欠ける、は起きない。監査行の INSERT が失敗すれば元の変更も戻る | 見えない（admin と所属者が `audit_log` を読める） | 元の操作を再試行するだけ | `supabase/__tests__/integration/audit-log-rls-idor.integration.test.ts` | 原子的 |
| M-005 | 施設削除 → 施設スコープ 12 表の CASCADE → `price_histories` の掃除（12 番のトリガー） | 1 文の DELETE なので途中で止まらない | 施設が一覧から消える | もう一度 DELETE すると 404 相当（行が無い） | `supabase/__tests__/integration/admin-user-replay.integration.test.ts`（2 回目は 0 行。12 表の CASCADE は 12 番の I-052） | 収束する |
| M-006 | 利用者削除（`auth.admin.deleteUser`）→ `user_facilities` の CASCADE | GoTrue 側の 1 トランザクション | 利用者が一覧から消え、本人は次のリクエストから拒否される（P-023） | もう一度 DELETE すると 404（利用者が無い）。一覧を再読込すれば消えている | `supabase/__tests__/integration/admin-user-replay.integration.test.ts` | 収束する |

### DB と応答（01x）

| ID | 経路（段の順） | 途中で止まる形 | 利用者に見えること | 再試行の約束 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| M-010 | 発注・返却の作成: DB は書けたが 201 が画面に届かない（通信断・タブを閉じた） | DB に発注はあるが画面は「失敗」を出す | 「失敗」の表示。再送ボタン | 画面は失敗後に同じ `clientRequestId` で再送し、RPC は既存行を `replayed: true` で返す。成功後は新しい鍵（P-053） | `supabase/__tests__/integration/order-idempotency.integration.test.ts`、`src/components/orders/__tests__/CaseOrderModal.client-request-id.test.tsx` | 収束する |
| M-011 | 施設別価格の更新: DB は書けたが応答が届かない | DB は新しい値、画面は古い値のまま | 「失敗」の表示 | 再保存すると `expectedUpdatedAt` が合わず競合として拒否される（自分の更新に負ける）。読み直せば新しい値が見える。行は増えない | `supabase/__tests__/integration/hospital-prices-concurrency.integration.test.ts` | 収束する |
| M-012 | マスタ（商品・カテゴリ・代理店商品・互換性）の作成: DB は書けたが応答が届かない | 行はある。再送すると同じ内容で 2 行目ができうる。products（jan・ref）・categories（name）・facilities（name）・product_compatibilities（三つ組）は UNIQUE で 23505 になり増えない | 「失敗」の表示 | UNIQUE が無い distributor_products だけ重複しうる。admin 専用で件数も少ないため、一覧で重複を見て消す運用 | 未 | 中間状態あり（#757-38: 代理店商品に（product_id, maker, name）の UNIQUE を足すか、`clientRequestId` を広げるかを決める） |

### 認証・招待（02x）

| ID | 経路（段の順） | 途中で止まる形 | 利用者に見えること | 再試行の約束 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| M-020 | 招待: `auth.admin.inviteUserByEmail` = 利用者の作成 → 招待メールの送信（GoTrue 内） | 応答が届かない、または admin が 2 回押す | 「失敗」または「送信しました」 | 同じメールへもう一度招待すると **同じ利用者**（id 不変）に `invited_at` を更新してメールを再送する（ローカル実測: 利用者 1・メール 2）。確認済みの利用者へは 422「既に登録されています」で行は増えない | `supabase/__tests__/integration/admin-user-replay.integration.test.ts` | 収束する |
| M-021 | 招待: 回数枠の消費 → `auth.admin.inviteUserByEmail`（利用者の作成 → メール送信） → 5xx なら枠の払い戻し | **利用者側は残らない**（2026-09-07 に SMTP を止めて 3/3 実測: 500 `Error sending invite email`、`auth.users` 0 件・`auth.identities` 0 件・`one_time_tokens` 0 件・GoTrue の監査行も無し。GoTrue が利用者行ごとロールバックする）。残るのは消費済みの回数枠だが、**5xx なら `refund_rate_limit()` で戻す**（2026-09-08） | 「招待メールの送信に失敗しました」 | 押し直せば新規の招待として通る（利用者行が無いので M-020 の再送ですらない）。送れなかった分の枠は戻っているので、SMTP 復旧後もその日の残りは減っていない | `src/app/api/admin/users/__tests__/route.test.ts` | 収束する |
| M-022 | MFA 登録: 未確認 factor の掃除 → `enroll` → `challenge` → `verify` | 途中で離脱すると unverified factor が残る | 次回「有効化」を押すと最初からやり直し | 次回の `enroll` 前に unverified factor を全部 `unenroll` してから作る | `src/app/account/mfa/__tests__/page.test.tsx` | 収束する |
| M-023 | 施設割当: `user_facilities` の upsert（1 文） | 途中で止まらない | 割当済みに変わる | 同じ組み合わせは upsert で 1 行のまま（role は後勝ち） | `supabase/__tests__/integration/admin-user-replay.integration.test.ts` | 原子的 |

### 画面（03x）

| ID | 経路（段の順） | 途中で止まる形 | 利用者に見えること | 再試行の約束 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| M-030 | admin 利用者画面: 招待成功 → 一覧の再読込（`reload()`） | 招待は済んだが一覧の再読込だけ失敗 | 「送信しました」の後、一覧に新しい利用者が出ない | ブラウザの再読込。招待をもう一度押しても M-020 で行は増えない | `src/components/admin/__tests__/InviteModal.test.tsx` | 収束する |
| M-031 | 発注画面: 作成成功 → 一覧へ遷移 | 遷移だけ失敗（まれ） | 発注は一覧にある | 再読込。もう一度作成すると **新しい鍵**なので 2 件目ができる（成功後は再送しない設計。利用者が意図して押した扱い） | `src/components/orders/__tests__/CaseOrderModal.client-request-id.test.tsx` | 収束する |

### 夜間・自動処理（04x）

| ID | 経路（段の順） | 途中で止まる形 | 利用者に見えること | 再試行の約束 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| M-040 | 夜間の不変条件検査: `record_business_invariants()`（DB）→ GitHub Actions が `schema_drift_log` を読んで issue 化 | DB には detected が残ったが issue 化だけ失敗（GitHub 停止・token 期限） | 何も見えない（開発者向け） | 翌晩の workflow が未 resolved の detected を再び拾う。`record_schema_drift` は自種別以外の行に触れない | `supabase/__tests__/integration/business-invariants-nightly.integration.test.ts`、`scripts/schema-drift-reconcile.test.sh` | 収束する |
| M-041 | 招待メール・通知の外部送信の再試行（送信キュー） | 機能が無い。送信は GoTrue が同期で 1 回だけ試みる | — | M-020 / M-021 | 未 | 未確認（#757-38: メール送信 API を自前で足すときにキューと再試行の約束を書く） |

## 無い経路（引き金が来たら行を足す）

- **在庫の減算**: 発注は記録だけで在庫数を持たない。「注文は作られたが在庫の減算だけ失敗」は機能が無い
- **決済・外部 API・Webhook・Storage・エクスポート**: 無い。追加したときに 01x / 04x に行を足す
- **月末締め・集計の確定**: 無い

## 読み方

- **原子的**は 5 行。すべて DB 側（RPC・トリガー・1 文の upsert）で、アプリ側の 2 段書きは存在しない。
  アプリ側で 2 回 `await` して 2 つの表を書く経路を足すときは、RPC に寄せるか、この表に「収束する」の根拠を書く。
- **収束する**は再試行の約束が「鍵」（M-010）か「UNIQUE / upsert」（M-006・M-020・M-023）か「掃除」（M-022）のどれか。
- **中間状態あり**は M-012（マスタ作成の再送）だけ。admin 専用で件数が少ないので運用で許容し、`clientRequestId` の拡張は引き金が来たら。
- **M-021 は測って初めて形が変わった行**。「利用者行が残るかも」という想定は外れで、残っていたのは**枠**だった。枠を戻す仕組み（`refund_rate_limit()`）を足して収束するようにした。
- **未確認**は M-041（送信キュー）だけ。機能を足すときに書く。

## 途中で止めて測るやり方

読んで判断すると「たぶん残る」で終わる。実際に止めて測った手順を残す
（GoTrue の版が上がったら同じ手順でやり直す。**版が変われば結果も変わりうる**）。

| 止めるもの | 手順 | 何を見るか |
| --- | --- | --- |
| メール送信（M-021） | `docker stop supabase_inbucket_<project>` → 招待 → `docker start` で戻す | `auth.users` / `auth.identities` / `auth.one_time_tokens` / `auth.audit_log_entries` の行数と、消費済みの回数枠 |

**利用者一覧（`listUsers`）だけを見ても足りない。** API の見え方であって、行が消えた証拠ではない。
DB を直接見て初めて「ロールバックされた」と言える（2026-09-07 はそこまで見て 3/3 一致）。

## 限界

- **実際に途中で止めて測ったのは一部。** 多くは経路を読んだ判断で、
  「原子的」と書いてあっても、実際に明細で失敗させてヘッダが残らないことを確かめたのは
  発注・返却の 4 経路と、SMTP を止めた招待（M-021、2026-09-07）だけ。
- **払い戻しは「もう 1 段」であって、消費と同じトランザクションではない。**
  払い戻し自体が失敗すると枠は 1 つ減ったまま戻らない（呼び出し側は続行する）。
  また、**上限に当たって止まった試行もカウンタを進める**（固定窓の性質）。止まった分は
  GoTrue を呼んでいないので払い戻しの対象でもなく、上限に当たり始めたら窓が変わるまで戻らない。
- **段の分け方は人が書く。** 実装が段を増やしても、この表の行が自動で増えることはない。
- **「収束する」は再試行したときの話**で、**再試行されなければ中間状態は残り続ける**。
  誰がいつ再試行するかは、この表の担当ではない。
- **外部サービスの中の段は見えない。** GoTrue の `inviteUserByEmail` は
  「利用者の作成 → メール送信」を内部で行う。2026-09-07 に SMTP を止めて測ったところ
  **この版はメール送信の失敗で利用者行ごとロールバックした**が、これは GoTrue の実装であって
  こちらが決めた約束ではない。**版が上がれば黙って変わりうる**（変わったことに気づく仕組みは無い）。
- **測ったのはローカルの SMTP 停止だけ。** 送信上限に当たった場合・SMTP が受け取ってから
  配送に失敗した場合は測っていない。後者は GoTrue から見れば成功なので、
  **アプリ側には「送った」としか残らない**（届いたかどうかはこの表の範囲外）。
