# 代替経路の棚卸し（X-xxx）

同じデータ（施設の発注・価格・所属・監査）に **API Route 以外から到達する経路**を列挙し、経路ごとに
「誰が・どの鍵で・何ができるか」「同じ攻撃を流す検査があるか」を書いたもの（issue #757 の 26）。
攻撃 E2E（P-017）は API Route しか叩かない。RLS の統合テストは PostgREST と RPC を叩く。
残りの経路（Studio・CLI・service role・pg_cron・preview・管理画面・復元）に同じ拒否条件が
効いているかは、経路ごとに見ないと分からない。脅威モデル（threat-model.md、22 番の PR）の入口
E-1〜E-10 を展開し、鍵の所在と突き合わせる。

## 更新ルール

- 列は固定 8 列: ID / 経路 / 誰が / どの鍵で / 何ができるか / 守るもの / 同じ攻撃を流す検査 / 状態。列の中に `|` を書かない。
- ID は `X-` + 3 桁。区分ごとに 10 刻み（アプリ経由 00x / DB へ直接 01x / 運用者と自動化 02x / 環境と復元 03x）。
- 「どの鍵で」は下の「鍵の所在」表の名前だけを使う（構造テストが語彙を固定する）。
- 状態は 4 語のみ: 検査あり（その経路で拒否条件を実測するテストがある）/ 一部 / 未（`#757-N` 必須）/ 対象外（経路が無い。理由を書く）。
- 「同じ攻撃を流す検査」列の `P-xxx` / `I-xxx` は各カタログに実在する（`scripts/check-access-path-inventory.test.sh`、CI `hooks-test`）。
- **更新の引き金**: 新しい入口（Edge Function・Storage・Webhook・外部連携・新しい鍵）、Vercel / Supabase の環境追加（preview・staging）、鍵のローテーション（#757-29）。

## 鍵の所在

| 鍵 | 誰が持つか | どこにあるか | 漏れたときの到達範囲 |
| --- | --- | --- | --- |
| anon key | 全員（ブラウザに公開） | `NEXT_PUBLIC_SUPABASE_ANON_KEY`（Vercel 環境変数・`.env.local`・CI はローカル Supabase 発行の値。`schema-drift-check.yml` だけ secrets 経由） | 単独では RLS で何も読めない。利用者 JWT と組で利用者の権限 |
| 利用者 JWT | ログインした利用者 | ブラウザの Cookie（`@supabase/ssr`）。有効期限は Supabase 既定 1 時間、権限変更は次のリクエストから効く（P-023） | その利用者の施設の読み書き（役割による） |
| service_role key | サーバー（admin 系 route・`requireAdmin`）、開発者 | `SUPABASE_SERVICE_ROLE_KEY`（Vercel 環境変数・`.env.local`）。CI・AI にはローカル Supabase の値しか渡さない。参照場所は `scripts/check-secret-leak.test.sh` が制限 | RLS を通らず全施設の読み書き。書き込みは監査ログに残る（読みは残らない） |
| Supabase アカウント | 開発者（ダッシュボード） | Supabase のログイン（Google SSO）。CLI の access token は開発機の keyring | Studio で全データの読み書きと DDL。DDL はドリフト検知、データ変更は監査ログに残る |
| postgres ロール | Studio の SQL Editor・pg_cron | DB 内部。人が直接持つのは Studio 経由のみ | 全権。トリガー（監査・append-only）は postgres でも効く |
| supabase_auth_admin | Supabase Auth 内部 | 人は持たない | `custom_access_token_hook` の実行のみ |
| GitHub token | 開発者・Actions | `gh` の keyring、Actions の `github.token` | コード・CI・issue。データには到達しない |
| Vercel アカウント | 開発者 | Vercel のログイン | 環境変数（service_role key を含む）の閲覧・変更。#757-35 |

## 一覧

### アプリ経由（00x）

| ID | 経路 | 誰が | どの鍵で | 何ができるか | 守るもの | 同じ攻撃を流す検査 | 状態 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| X-001 | Next.js API Route（`src/app/api/**/route.ts`） | 利用者・他施設の利用者・匿名 | 利用者 JWT（anon key と組） | 自施設の読み書き。admin 系は admin のみ | `requireAuth` / `requireFacilityAccess` / `resolveIsAdmin` + RLS | P-001、P-002、P-017（全 route × 全メソッドの総当たり、ratchet）、P-021 | 検査あり |
| X-002 | 画面（Server Components・client の fetch） | 利用者 | 利用者 JWT | X-001 と同じ（画面は API Route か Supabase を呼ぶだけ） | proxy（未認証・MFA・admin ガード）+ X-001 | P-016（他施設の一覧 URL）、P-030 の proxy 側は `src/__tests__/proxy.test.ts` | 検査あり |
| X-003 | PostgREST 直接（`/rest/v1/<table>`） | 利用者・他施設の利用者・匿名 | 利用者 JWT（anon key と組）。匿名は anon key のみ | RLS が許す行の読み書き。匿名は表への GRANT を REVOKE 済み | RLS ポリシー（`is_facility_member` / `is_facility_writer` / `is_admin` / `has_aal2`） | P-010、P-011、P-013、P-014、P-015、P-020、P-021、P-031、P-040、P-042 | 検査あり |
| X-004 | RPC 直接（`/rest/v1/rpc/<fn>`） | 利用者・他施設の利用者・匿名 | 利用者 JWT または anon key | 公開 RPC の実行（発注・返却の作成、認可述語、レポート、ニュース） | 関数内の認可 + GRANT / REVOKE + `search_path=''` | P-012、P-030、P-041、P-043（公開 RPC は境界テスト必須の ratchet）、P-044、P-045、P-053 | 検査あり |

### DB へ直接（01x）

| ID | 経路 | 誰が | どの鍵で | 何ができるか | 守るもの | 同じ攻撃を流す検査 | 状態 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| X-010 | service role でのアプリ内アクセス（admin 系 route・`requireAdmin`） | サーバー（admin として認証済みの利用者の代理） | service_role key | `user_facilities` の upsert / delete、利用者の招待・削除、admin 判定 | route の `requireAdmin`（P-021 と同じ admin 判定）。書き込みは監査ログ | P-017（admin 系 route は proxy が /login へ）、P-060（`user_facilities` の変更が actor 付きで残る） | 検査あり |
| X-011 | service role の手動利用（開発者の CLI・スクリプト） | 開発者 | service_role key | 全施設の読み書き。DDL は不可（postgres ではない） | 書き込みは監査ログ（`actor_role = service_role`、actor_id null）。**読み取りは記録されない** | P-060、P-061（service_role でも監査行を消せない）。読み取りの記録は未（#757-24） | 一部 |
| X-012 | Supabase Studio（Table Editor・SQL Editor） | 開発者 | Supabase アカウント（postgres ロール） | 全データの読み書き、DDL、RLS の編集、トリガーの無効化 | DDL とポリシー変更は日次のスキーマドリフト検知（issue 化）。データ変更は監査ログ（`actor_role = postgres`）。トリガー無効化は `ALTER TABLE ... DISABLE TRIGGER` がドリフト検知の対象か未確認 | P-040、P-042、P-060、P-061。ドリフト検知は `supabase/migrations/__tests__/schema_drift_detection.test.ts`。読み取りとトリガー無効化は未（#757-24・35） | 一部 |
| X-013 | Supabase CLI（`supabase db push` / migration） | 開発者 | Supabase アカウント（CLI の access token） | migration の適用（DDL・データ移行） | migration は PR 経由（静的テスト・ratchet・統合テスト）。直接の `psql` / `db execute` は hook が deny（H-003） | migration 静的テスト、`constraint_coverage_ratchet.test.ts`、統合テスト全件 | 検査あり |

### 運用者と自動化（02x）

| ID | 経路 | 誰が | どの鍵で | 何ができるか | 守るもの | 同じ攻撃を流す検査 | 状態 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| X-020 | pg_cron（`schema-drift-daily-check`、`business-invariants-daily-check`） | DB 内部（postgres） | postgres ロール | `record_schema_drift()` / `record_business_invariants()` の実行（`schema_drift_log` への書き込みのみ） | 関数は service_role 限定（client から呼べない）。書く先はドリフトログだけで業務データに触れない | P-044、`supabase/migrations/__tests__/add_nightly_invariant_check.test.ts`、I-050、I-051 | 検査あり |
| X-021 | Auth hook（`custom_access_token_hook`） | Supabase Auth 内部 | supabase_auth_admin | JWT に `user_role` クレームを埋める（読み取りのみ） | authenticated / anon / PUBLIC から REVOKE。クレームは UI 専用で認可に使わない | P-022、P-023 | 検査あり |
| X-022 | 管理画面（`/admin/*`、`/api/admin/*`） | admin | 利用者 JWT（admin）+ サーバー側の service_role key | 利用者の招待・削除、所属とロールの変更、レポート | proxy の admin ガード + `requireAdmin` | P-017（admin 系 route）、P-021、P-060（`user_facilities`）。`auth.users` の変更（招待・削除）は監査ログの対象外（auth スキーマ）→ 未（#757-24） | 一部 |
| X-023 | GitHub Actions（CI） | Actions | GitHub token。Supabase の鍵はローカル Supabase 発行の値のみ（本番の鍵は渡さない。`schema-drift-check.yml` だけ anon key を secrets から） | ローカル DB でのテスト。本番データには到達しない | secrets を渡さない設計、`npm install` 禁止、ロック出所 | `scripts/check-no-registry-fetch.test.sh`、`scripts/check-lockfile-integrity.test.sh`、`scripts/check-secret-leak.test.sh` | 検査あり |
| X-024 | AI エージェント（Claude Code・Codex） | 開発者の代理 | ローカル Supabase の鍵のみ。本番の service_role key は渡さない（H-011） | ローカル DB の読み書き、コードの変更（PR 経由） | PreToolUse hook（DDL deny・依存 ask・readonly deny）、秘密情報の走査 | `scripts/check-secret-leak.test.sh`（参照場所）、hook 回帰。本番の鍵を渡さない運用自体は検査できない（H-011） | 一部 |

### 環境と復元（03x）

| ID | 経路 | 誰が | どの鍵で | 何ができるか | 守るもの | 同じ攻撃を流す検査 | 状態 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| X-030 | Vercel の preview デプロイ | PR の URL を知る人 | Vercel アカウントが設定した preview の環境変数（本番と同じ Supabase を指すかは未確認） | 本番と同じなら本番データへの入口が増える | Vercel の環境変数を preview / production で分ける | 未（#757-35: preview の `NEXT_PUBLIC_SUPABASE_URL` が本番かを確認し、本番なら preview 用の Supabase か無効化を決める） | 未（#757-35） |
| X-031 | Supabase の preview branch（GitHub 連携の「Supabase Preview」check） | GitHub 連携 | Supabase アカウントが GitHub 連携に与えた権限 | 現状 skipping（branching 未使用）。有効化すると PR ごとに DB の複製ができる | 使わない | 対象外（branching を使っていない。有効化するときに引き金） | 対象外 |
| X-032 | バックアップからの復元 | Supabase（開発者の操作） | Supabase アカウント | 削除済みデータ・古い権限・古い RLS が戻る | 復元後に統合テストを回す手順（未） | 未（#757-23） | 未（#757-23） |
| X-033 | Edge Functions・Storage・Webhook・外部連携 | — | — | 機能が無い | — | 対象外（追加時に行を足す） | 対象外 |
| X-034 | 旧 API バージョン | — | — | API のバージョニングをしておらず、デプロイは常に 1 つ | — | 対象外 | 対象外 |

## 読み方

- **検査あり** 10 経路は、同じ拒否条件を約束カタログの ID で実測している。
- **一部** 4 経路（X-011・X-012・X-022・X-024）の共通の穴は「service role / postgres / auth スキーマの**読み取りと一部の変更が記録されない**」で、#757-24（拒否・admin 操作の記録）と #757-35（設定ドリフト）に集約される。
- **未** 2 経路（X-030 preview、X-032 復元）は Vercel / Supabase のダッシュボードを見るところから。

## 限界

- **思いつけた経路しか載らない。** 18 行あることは網羅の証拠ではない。
  新しい経路（Webhook・エクスポート・外部連携・別のクライアント）が増えても、
  ここへ行を足すのは人の作業で、**足し忘れは機械では気づけない**。
- **鍵の所在は宣言。** 「利用者 JWT」と書いてある経路が、実際にその鍵しか使っていないかは
  この表では確かめていない（service role が紛れ込んでいないかは
  [`privileged-write-rulebook.md`](./privileged-write-rulebook.md) が別に見る）。
- **「検査あり」は同じ攻撃を流せることを指すだけ**で、その検査が破れば落ちるかは別。
  そこは [`rls-mutation.md`](./rls-mutation.md) と
  [`mutation-testing.md`](./mutation-testing.md) が測る。
- **人が直接触る経路（Studio・ダッシュボード）は範囲外**として扱っており、
  そこからの操作は記録にも残らない（[`blast-radius.md`](./blast-radius.md) の B-010）。
