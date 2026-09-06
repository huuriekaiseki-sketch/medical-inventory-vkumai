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
| F-001 | `requireAuth`（`src/lib/supabase/require-auth.ts`） | Supabase Auth（`getUser`） | `error \|\| !user` で `UNAUTHORIZED` → route が 401 | 閉じる | `src/lib/supabase/__tests__/require-auth.test.ts` |
| F-002 | `requireFacilityAccess`（`src/lib/supabase/require-facility-access.ts`） | RPC `is_facility_member`・DB | `error \|\| !data` で `FORBIDDEN` → 403。admin 判定は F-003 | 閉じる | `src/lib/supabase/__tests__/require-facility-access.test.ts`（RPC error のとき FORBIDDEN） |
| F-003 | `resolveIsAdmin`（`src/lib/admin-status.ts`） | RPC `get_admin_status`・DB | `error \|\| !data \|\| 0 件` で非 admin。`ADMIN_EMAILS` フォールバックは「DB に admin が 0 件」と**確認できた**ときだけ効く（RPC が落ちているときは効かない） | 閉じる | `src/lib/__tests__/admin-status.test.ts`（RPC エラー時は false） |
| F-004 | proxy の MFA ガード（`src/proxy.ts`） | Supabase Auth MFA API（`getAuthenticatorAssuranceLevel`） | **2026-09-06 まで開いていた**（error を捨て、aal が取れなければ素通り）。今は `error \|\| !aal` で `/mfa-challenge` へ送る。`/mfa-challenge` 自体は通す（ループしない） | 閉じる | `src/__tests__/proxy.test.ts`（MFA API がエラー / data null → /mfa-challenge） |
| F-005 | proxy の未認証ガード・admin ガード（`src/proxy.ts`） | Supabase Auth・RPC | `getUser` の error は未認証扱いで `/login`。admin は F-003 | 閉じる | `src/__tests__/proxy.test.ts`（getUser がエラー → /login、admin RPC 不成立 → /login） |
| F-006 | `requireAdmin`（`src/lib/admin-auth.ts`） | Supabase Auth・RPC | `error \|\| !user` で null（route が 403）。admin は F-003 | 閉じる | `src/lib/__tests__/admin-auth.test.ts` |
| F-007 | 画面のロール判定（`src/hooks/useFacilityRole.ts`） | `/api/facilities/[id]/my-role` | fetch 失敗で `role: null`、`canWrite: false`（ボタンを出さない）。防御は DB 側 | 閉じる（UI） | `src/hooks/__tests__/` |
| F-008 | `/api/facilities/[id]/my-role` | RPC・DB | `resolveIsAdmin` 失敗は非 admin、`getUserFacilityRole` の error は 500（role を返さない） | 閉じる | `src/app/api/facilities/[id]/my-role/__tests__/` |
| F-009 | API Route の body 解析（`request.json()` の catch） | 不正な body | 400 を返す。認可には関与しない | 情報のみ | 各 route のテスト |
| F-010 | データ層の RPC 呼び出し（発注 4 種・レポート・ニュース・価格履歴） | RPC・DB | `error` を投げ、route が 500。行は作られない | 閉じる | 各リポジトリの単体テスト（Supabase エラー時に例外） |
| F-011 | RLS の認可述語（`is_facility_member` / `is_facility_writer` / `is_admin` / `has_aal2`） | DB 内部 | SQL 関数の例外は文（SELECT / INSERT）ごと失敗する。`has_aal2` は JWT に `aal` が無ければ false | 閉じる | P-010〜P-013、P-030、P-031 の統合テスト |
| F-012 | 監査トリガー `audit_row_change`（20260906000004） | `audit_log` への INSERT | EXCEPTION 節が無く、記録できなければ元の書き込みごとロールバック（監査が止まると書き込みも止まる。可用性より証跡を優先） | 閉じる | `supabase/migrations/__tests__/add_audit_log.test.ts`、P-060 |
| F-013 | 状態遷移トリガー `enforce_status_forward_only`・CHECK 制約 | DB 内部 | 例外で書き込み失敗 | 閉じる | I-010〜I-020 の統合テスト |
| F-014 | 発注 RPC の `unique_violation` 処理（P-053） | 同時送信 | 鍵で相手の行が見つかったときだけ再送扱い、見つからなければ再 RAISE（P-050 の 23505 を握らない） | 閉じる | `supabase/__tests__/integration/order-idempotency.integration.test.ts` |
| F-015 | JWT の `user_role` クレーム（`custom_access_token_hook`） | hook の失敗 | Supabase Auth はトークンを発行しない（ログイン失敗）。クレームが null なら RLS は `user_facilities` を毎回引く | 閉じる | `supabase/migrations/__tests__/add_custom_access_token_hook.test.ts`、P-022 |
| F-016 | MFA チャレンジ画面（`src/app/mfa-challenge/page.tsx`） | MFA API | aal が取れなければ「達成済み」とみなさず、factor 一覧の取得失敗を表示する。データは出さない | 閉じる（UI） | — |
| F-017 | MFA 設定画面（`src/app/account/mfa/page.tsx`） | MFA API | 一覧・登録・検証・解除の各 error を表示して止まる。未確認 factor の掃除失敗も止める | 情報のみ | — |
| F-018 | 一覧・詳細の取得（画面の `.catch`） | API・ネットワーク | エラー文言を表示し、データを出さない | 情報のみ | 各画面のテスト |
| F-019 | Supabase 全停止 | DB・Auth | F-001〜F-006 がすべて拒否側に倒れる。画面は F-018 でエラー表示。発注はできない（可用性の損失。#757-8 の監視で気づく） | 閉じる | 上記の合成。実測（Supabase を止めて叩く）は「障害注入（外部依存停止）」の節目で |

## 見つけた穴（2026-09-06）

- **F-004**: proxy の MFA ガードが `error` を捨てていた。Supabase Auth の MFA API が落ちている間、
  MFA 登録済み利用者の aal1 セッションが保護ページを読めた（DB は書き込みだけ aal2 を要求）。
  fail-closed に直し、テストで固定。
- 同型の「`error` を捨てる destructuring」が `layout.tsx`・`admin-auth.ts`・`account/mfa`（掃除の
  unenroll）にあった。挙動上の穴ではなかったが、規約に揃えた（構造テストが以後の新規発生を止める）。

## 更新の引き金

- 認可・認証・MFA の判定材料を取る箇所（`proxy.ts`・`require-*.ts`・`admin-*.ts`・`useFacilityRole`・
  MFA 画面）を触る PR は、この表の該当行と「守るテスト」を更新する（derive の `fault-injection` が
  手元実行を要求する）。
- 新しい外部依存（メール・決済・Storage・Webhook）を足すときは、その停止時の行を足す。
- 実測（Supabase を実際に止める）は test-matrix「障害注入（外部依存停止）」の節目（依存 major 更新・
  外部公開前）で行い、この表の F-019 に記録する。
