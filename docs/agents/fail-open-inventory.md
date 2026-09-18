# fail-open の棚卸し（F-xxx）

「判定材料が取れなかったとき、どちらに倒れるか」を制御点ごとに一覧にしたもの（issue #757 の 31）。
hook 側の fail-open は既知の制約として [known-failure-patterns.md](./known-failure-patterns.md#fail-open-の-warning-only-hook-が入力形式の変化で無音のまま死ぬ2026-09-05)
に記録済みで、ここは**製品側**（Next.js の proxy・API Route・データ層・DB）を扱う。

## 方針

- **認可・認証・MFA の判定は、エラーを「拒否」と同一視する**（fail-closed）。`{ data, error }` を返す
  呼び出しは必ず `error` を受け取り、`error || !data` を拒否側に倒す。判定材料が取れないときに
  「通す」経路を残さない。
- **可用性側の catch（一覧の取得失敗・フォームの送信失敗）は情報のみ**。画面にエラーを出し、
  データを出さない。認可には関与しない。
- **DB は例外を伝播させる**。認可述語（`is_facility_member` 等）・トリガー（監査・状態遷移）・RPC の
  中で例外を握らない。握るのは `unique_violation` を「再送」として扱う RPC（P-053）だけで、
  それも鍵で相手の行が見つからなければ再 RAISE する。
- 機械検査: `scripts/check-fail-open.test.sh`（CI `hooks-test`）が (a) `src/` の `await …rpc(` /
  `auth.getUser(` / `auth.mfa.*` の行が `error` を受け取っていること、(b) 下表の「守るテスト」列の
  パスが実在することを検査する。RED 方向は fixture で確認。

## 状態の読み方

| 状態 | 意味 |
| --- | --- |
| 閉じる | 材料が取れないと拒否・失敗・データなしになる。守るテストがある |
| 情報のみ | 認可に関与しない。エラー表示だけ |
| 開く | 材料が取れないと通ってしまう。**残してはいけない**（見つけたら直すか、理由を書いて #757 の番号を付ける） |

## 一覧

| ID | 制御点 | 止まるもの | 材料が取れないときの挙動 | 状態 | 守るテスト |
| --- | --- | --- | --- | --- | --- |
| F-001 | `requireAuth`（`src/lib/supabase/require-auth.ts`） | Supabase Auth（`getUser`） | `error \|\| !user` で `UNAUTHORIZED` → route が 401。**5 秒で諦める**（諦めたら user なし＝同じ拒否へ倒れる。2026-09-08） | 閉じる | `src/lib/supabase/__tests__/require-auth.test.ts` |
| F-002 | `requireFacilityAccess`（`src/lib/supabase/require-facility-access.ts`） | RPC `is_facility_member`・DB | `error \|\| !data` で `FORBIDDEN` → 403。admin 判定は F-003。**各段 5 秒で諦める**が、3 段直列なので最悪 15 秒（2026-09-08） | 閉じる | `src/lib/supabase/__tests__/require-facility-access.test.ts`（RPC error のとき FORBIDDEN） |
| F-003 | `resolveIsAdmin`（`src/lib/admin-status.ts`） | RPC `get_admin_status`・DB | `error \|\| !data \|\| 0 件` で非 admin。`ADMIN_EMAILS` フォールバックは「DB に admin が 0 件」と**確認できた**ときだけ効く（RPC が落ちているときは効かない）。**5 秒で諦める**（2026-09-08） | 閉じる | `src/lib/__tests__/admin-status.test.ts`（RPC エラー時は false） |
| F-004 | proxy の MFA ガード（`src/proxy.ts`） | **手元の JWT の `aal` クレーム**（`getAuthenticatorAssuranceLevel` は GoTrue を呼ばない。2026-09-08 に GoTrue を止めて実測: **2 ms で成功**） | **2026-09-06 まで開いていた**（error を捨て、aal が取れなければ素通り）。今は `error \|\| !aal` で `/mfa-challenge` へ送る。GoTrue の停止では失敗しない（トークンが無い・壊れているときだけ失敗する） | 閉じる | `src/__tests__/proxy.test.ts`（MFA API がエラー / data null → /mfa-challenge） |
| F-005 | proxy の未認証ガード・admin ガード（`src/proxy.ts`） | Supabase Auth・RPC | `getUser` の error は未認証扱いで `/login`。admin は F-003。**（#757-24）** admin ガードの転送に拒否の記録が付随する。記録の 3 層（印の付与 = proxy の cookie set / 印の読み取り = `/login` の `parseProxyDenial` / RPC = `record_access_denial`）はいずれも fail-open（失敗しても `/login` の表示・判定は変わらない）で、判定（redirect するかどうか）は fail-closed のまま。**記録の失敗は握りつぶすが無音にはしない**（2026-09-18。env 未設定は初回だけ `access_denial_client_unavailable`、`recordAccessDenial` の外側 catch は `record_access_denial_unexpected`、`/login` の保険 catch は `proxy_admin_denial_record_failed` を `logServerError` に出す。**2026-09-19（issue #793）に残り 3 経路も塞いだ**——`hidden-row-denial` / `privileged-operation` / `rate-limit` も env 未設定時に黙って落ちていた。4 ファイルにコピペされていたクライアント生成は `src/lib/security/service-role-client.ts` へ一本化し、logKey は呼び出し元ごとに分けてある（どの記録経路が死んだかを区別するため）。**「記録しない」は仕様のままで、変えたのは「黙って」の部分だけ**）。MFA 未昇格の非 admin は MFA ガードで先に `/mfa-challenge` へ送られるため、この経路の拒否は記録されない（既知の限界として受け入れる） | 閉じる | `src/__tests__/proxy.test.ts`（getUser がエラー → /login、admin RPC 不成立 → /login、拒否記録用の印の付与・削除）、`src/app/login/__tests__/page.test.tsx`（印の読み取り・fail-open） |
| F-006 | `requireAdmin`（`src/lib/admin-auth.ts`） | Supabase Auth・RPC | `error \|\| !user` で null（route が 403）。admin は F-003 | 閉じる | `src/lib/__tests__/admin-auth.test.ts` |
| F-007 | 画面のロール判定（`src/hooks/useFacilityRole.ts`） | `/api/facilities/[id]/my-role` | fetch 失敗で `role: null`、`canWrite: false`（ボタンを出さない）。防御は DB 側 | 閉じる（UI） | `src/hooks/__tests__/` |
| F-008 | `/api/facilities/[id]/my-role` | RPC・DB | `resolveIsAdmin` 失敗は非 admin、`getUserFacilityRole` の error は 500（role を返さない） | 閉じる | `src/app/api/facilities/[id]/my-role/__tests__/` |
| F-009 | API Route の body 解析（`request.json()` の catch） | 不正な body | 400 を返す。認可には関与しない | 情報のみ | 各 route のテスト |
| F-010 | データ層の RPC 呼び出し（発注 4 種・レポート・ニュース・価格履歴） | RPC・DB | `error` を投げ、route が 500。行は作られない | 閉じる | 各リポジトリの単体テスト（Supabase エラー時に例外） |
| F-011 | RLS の認可述語（`is_facility_member` / `is_facility_writer` / `is_admin` / `has_aal2`） | DB 内部 | **その述語が評価されたときだけ**、例外が文ごと失敗になる（2026-09-08 実測。permissive なポリシーは OR で合成されるので、別のポリシーが先に通すと**壊れた述語は呼ばれない**）。`has_aal2` は **TOTP 登録済みの利用者から `aal` を剥いだとき**に false（未登録の利用者には `aal` を見ずに true。20260806000001 の設計） | 閉じる | `supabase/__tests__/fault-injection/db-internal.faultinjection.test.ts` |
| F-012 | 監査トリガー `audit_row_change`（20260906000004） | `audit_log` への INSERT | EXCEPTION 節が無く、記録できなければ元の書き込みごとロールバック（監査が止まると書き込みも止まる。可用性より証跡を優先）。**2026-09-08 に監査ログを書けない状態を作って実測**: 業務データの INSERT が 23514 で失敗し、行は 1 件も残らなかった | 閉じる | `supabase/__tests__/fault-injection/db-internal.faultinjection.test.ts` |
| F-013 | 状態遷移トリガー `enforce_status_forward_only`・CHECK 制約 | DB 内部 | 例外で書き込み失敗 | 閉じる | I-010〜I-020 の統合テスト |
| F-014 | 発注 RPC の `unique_violation` 処理（P-053） | 同時送信 | 鍵で相手の行が見つかったときだけ再送扱い、見つからなければ再 RAISE（P-050 の 23505 を握らない） | 閉じる | `supabase/__tests__/integration/order-idempotency.integration.test.ts` |
| F-015 | JWT の `user_role` クレーム（`custom_access_token_hook`） | hook の失敗 | Supabase Auth はトークンを発行しない（ログイン失敗）。クレームが null なら RLS は `user_facilities` を毎回引く | 閉じる | `supabase/migrations/__tests__/add_custom_access_token_hook.test.ts`、P-022 |
| F-016 | MFA チャレンジ画面（`src/app/mfa-challenge/page.tsx`） | MFA API | aal が取れなければ「達成済み」とみなさず、factor 一覧の取得失敗を表示する。データは出さない | 閉じる（UI） | — |
| F-017 | MFA 設定画面（`src/app/account/mfa/page.tsx`） | MFA API | 一覧・登録・検証・解除の各 error を表示して止まる。未確認 factor の掃除失敗も止める | 情報のみ | — |
| F-018 | 一覧・詳細の取得（画面の `.catch`） | API・ネットワーク | エラー文言を表示し、データを出さない | 情報のみ | 各画面のテスト |
| F-019 | Supabase の停止（PostgREST 単独 / GoTrue 単独） | DB・Auth | **2026-09-08 に実測**: 判定はすべて拒否側へ倒れたが、**倒れるまでに 55〜75 秒かかる**（下の実施記録）。向きは正しく、遅さが別の壊れ方になる | 閉じる | `supabase/__tests__/fault-injection/fail-open.faultinjection.test.ts` |

## 見つけた穴（2026-09-06）

- **F-004**: proxy の MFA ガードが `error` を捨てていた。Supabase Auth の MFA API が落ちている間、
  MFA 登録済み利用者の aal1 セッションが保護ページを読めた（DB は書き込みだけ aal2 を要求）。
  fail-closed に直し、テストで固定。
- 同型の「`error` を捨てる destructuring」が `layout.tsx`・`admin-auth.ts`・`account/mfa`（掃除の
  unenroll）にあった。挙動上の穴ではなかったが、規約に揃えた（構造テストが以後の新規発生を止める）。

## 実測の記録（依存を実際に止める）

`bash scripts/measure-fail-open.sh` で測る（CI では回さない。test-matrix の
「障害注入（外部依存停止）」＝節目）。**出力そのものが成果物**なので、結果をここへ書き写す。

### 2026-09-08（初回。PostgREST 単独停止 / GoTrue 単独停止）

| 制御点 | 平常時 | PostgREST 停止 | GoTrue 停止 |
| --- | --- | --- | --- |
| `requireAuth`（F-001） | 通す 18 ms | 通す **18,493 ms** | 拒否 **54,336 ms** |
| `resolveIsAdmin`（F-003） | 非 admin 10 ms | 非 admin **75,389 ms** | — |
| `requireFacilityAccess`（F-002） | 通す 2 ms | 拒否 **55,297 ms** | — |
| `mfa.getAuthenticatorAssuranceLevel`（F-004） | — | — | **成功 2 ms**（呼んでいない） |

**分かったこと（3 つとも読んでいたときは見えなかった）**

1. **向きは全部正しい。** 認可の判定はどれも拒否側へ倒れ、`getUser` の失敗は
   例外ではなく**戻り値の `error`** で来た（`error \|\| !user` の前提が成り立っている）。
2. **遅さが別の壊れ方になる。** 拒否するまでに 55〜75 秒かかる。`supabase-js` の fetch に
   タイムアウトが無く、Kong が居ない upstream を長く待つため。Vercel の関数はその前に
   打ち切られるので、利用者から見ると 504 になる。
   **`requireAuth` は全 route が通る**（Q-002 の回数を数えるため RPC を呼ぶ）ので、
   PostgREST が落ちると認可に関係ない読み取りまで 18 秒待たされる。
   何秒で諦めるかは人が決める値（未決）。
3. **F-004 の「止まるもの」が実態と違っていた。** `getAuthenticatorAssuranceLevel()` は
   GoTrue を呼ばず、手元の JWT の `aal` クレームを読むだけ（GoTrue 停止中に 2 ms で成功）。
   穴ではない（aal2 のトークンを持つ人が通るのは正しい）が、
   **「Auth が落ちたら MFA ガードが閉じる」という読み方は誤り**だった。

**あわせて観測されたこと**: PostgREST 停止中は `record_access_denial` も失敗する
（`An invalid response was received from the upstream server`）。設計どおり操作は止めないが、
**外部依存が落ちている間の拒否は 1 件も記録に残らない**。
「記録が無い ＝ 起きていない」と読めないことの実例で、監視（#757-8）の前提に関わる。

**測らなかったもの**: DB（Postgres）単独の停止、Kong の停止、同時に複数が落ちる場合。
本番の Supabase（プール・リージョン越し）での時間はローカルと違う。

### 2026-09-08（2 回目。DB の中を壊す）

外から依存を止めても DB の中の例外は起きないので、**DB の中で実際に壊して**測った
（監査ログに必ず失敗する CHECK を足す／認可述語を例外を投げる版に差し替える）。

| 壊したもの | 結果 |
| --- | --- |
| 監査ログに書けなくする（F-012） | 業務データの INSERT が **23514 で失敗**し、`facilities` の行は **0 件**。宣言どおり |
| 認可述語を例外にする・**staff**（F-011） | **1 件返った**。writer 側のポリシーが先に通し、壊れた述語は呼ばれない |
| 認可述語を例外にする・**viewer**（F-011） | **P0001 で文ごと失敗**。0 件ではなく失敗（壊れていることに気づける） |
| `has_aal2` にクレームを渡す（F-011） | 未登録(aal なし)=**true** / 登録済み(aal なし)=**false** / 登録済み(aal1)=**false** / 登録済み(aal2)=**true** |

**分かったこと**

1. **F-012 の強い宣言は本当だった。** 「監査が止まると書き込みも止まる」は実測で確認できた。
   **記録の残らない書き込みは作れない**（この製品でいちばん強い保証の 1 つ）。
2. **F-011 の「例外は文ごと失敗する」は条件付きだった。** permissive なポリシーは OR で合成され、
   別のポリシーが先に通すと**壊れた述語はそもそも評価されない**。
   「述語が壊れたら必ず落ちる」と読むと、**壊れていることに気づけない場合がある**。
3. **`has_aal2` の書き方が不正確だった。** 「`aal` が無ければ false」ではなく、
   **TOTP 登録済みの利用者から `aal` を剥いだときだけ false**。
   未登録の利用者には `aal` を見ずに true を返す（MFA 未登録の運用を壊さないための設計）。
   安全上効いてほしい側（登録済みから剥ぐ）は効いている。

**測り方の落とし穴（初回に 2 回踏んだ）**: RLS の USING 句は**行ごと**に評価されるので、
対象の表が 0 行だと述語は一度も呼ばれず「0 件」が返る。**壊しても何も起きない**のに
「例外にならなかった」と読めてしまう。行を 1 つ入れてから測る。

### 2026-09-08（3 回目。判定に待ち時間の上限を入れた前後）

2 回目の実測で「向きは正しいが 55〜75 秒かかる」と分かったので、
**認可・認証の判定に 5 秒の上限**を入れた（人が決めた値。`aidd.config.json` の
`limits.authJudgmentTimeoutMs`）。同じ手順で測り直した。

| 制御点（PostgREST か GoTrue を停止） | 入れる前 | 入れた後 |
| --- | --- | --- |
| `resolveIsAdmin`（F-003） | 75,389 ms | **5,004 ms** |
| `requireAuth` / PostgREST 停止（F-001） | 18,493 ms | **5,042 ms** |
| `requireAuth` / GoTrue 停止（F-001） | 54,336 ms | **5,011 ms** |
| `requireFacilityAccess`（F-002） | 55,297 ms | **15,008 ms** |

**判定だけでは足りなかった。** 最初に判定 3 つへ上限を入れた時点で
`requireFacilityAccess` は 26,611 ms のままだった。内訳を見ると
5 秒（admin 判定）＋ 5 秒（所属判定）＋ **約 16 秒（拒否の記録）**で、
**記録で待たされて上限の意味が消えていた**。記録（`record_access_denial` /
`record_privileged_operation`）は元から失敗を握りつぶす設計なので、同じ上限を付けた。

**残っているもの: 直列に積み上がる。** `requireFacilityAccess` の最悪経路は
admin 判定 → 所属判定 → 拒否の記録 の 3 段で、**3 × 5 = 15 秒**。
1 段ごとには上限どおりでも、合計は上限ではない。
次の一手は「1 回のリクエストで最初の 1 つが諦めたら、残りは待たずに諦める」（回路遮断器）だが、
**状態を持つ仕組み**になるので別の判断が要る。

## 限界

- **実測したのは 6 行**（F-001〜F-004・F-011・F-012、2026-09-08）。残り 13 行はコードを読んだ判断で、
  読み違いがあればそのまま「閉じる」と書かれ続ける。
  **実測した 6 行のうち 3 行で書き方が実態と違っていた**（F-004 の依存・F-011 の条件・
  `has_aal2` の説明）。読んでいたときは 3 つとも気づけなかった。
- **「閉じる」は向きの話で、速さは別。** 判定材料が取れないとき拒否側へ倒れることと、
  そこまでに 1 分待たないことは別の性質で、**この表は向きしか見ていない**（時間は実施記録に）。
- **上限は 1 段ごとで、合計ではない。** 判定が直列に積み上がる経路は段数 × 5 秒かかる
  （`requireFacilityAccess` は 15 秒）。1 リクエスト全体の上限は持っていない。
- **要求そのものは止めていない。** 待つのをやめるだけで、裏の fetch は走り続ける
  （理由は `src/lib/security/judgment-timeout.ts` の「既知の限界」）。
- **重い一覧・レポートには上限を付けていない**（2026-09-08 の判断）。そこが遅いままなのは既知。
- **同時に複数が落ちたときの合成は見ていない。** 1 つずつは拒否側へ倒れても、
  組み合わさると別の経路が開くことがある（例: 認可 RPC が落ちた状態で画面のロール判定も落ちる）。
- **「情報のみ」は防御ではない。** 画面側の制御点（F-009・F-017・F-018）は
  文言を出すだけで、データを守っているのは API と RLS。ここが緑でも守られている証明にならない。
- **記録側の fail-open は意図的**（`access_denials` / `privileged_operations` の記録は
  失敗しても操作を止めない）。**取りこぼしはゼロにならない**ので、
  「記録が無い ＝ 起きていない」とは読めない。

## 更新の引き金

- 認可・認証・MFA の判定材料を取る箇所（`proxy.ts`・`require-*.ts`・`admin-*.ts`・`useFacilityRole`・
  MFA 画面）を触る PR は、この表の該当行と「守るテスト」を更新する（derive の `fault-injection` が
  手元実行を要求する）。
- 新しい外部依存（メール・決済・Storage・Webhook）を足すときは、その停止時の行を足す。
- 実測（Supabase を実際に止める）は test-matrix「障害注入（外部依存停止）」の節目（依存 major 更新・
  外部公開前）で行い、この表の F-019 に記録する。
