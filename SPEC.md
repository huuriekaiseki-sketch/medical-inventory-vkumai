# SPEC: /admin・/api/admin への未認可アクセスを access_denials に記録する（issue #757 の 24 の残り）

## Part 1 — 仕様（★人間がレビューする部分）

### 何ができるようになるか

現状、管理画面（`/admin/*`・`/api/admin/*`）に「ログインしていない人」または「ログインしているが管理者でない人」がアクセスすると、proxy（旧 middleware）が `/login` へ跳ね返します。この跳ね返しは今まで通り動きますが、**「誰が・いつ・どの画面で弾かれたか」が一切残っていません**（P-063 の限界欄に「未記録」と書いてある穴）。

今回の変更で、この跳ね返しが起きるたびに、既存の「弾かれた操作の記録簿」（`access_denials`。管理者だけが `/admin/audit` の「拒否」タブで見られる）に 1 行残ります。利用者から見た画面の動き・ログイン体験は変わりません。変わるのは「管理者が後から `/admin/audit` を見たときに、この弾かれ方も見える」ことだけです。

### 画面イメージ

見た目・操作感の変更は無いため、モックは作成していません。

- `/login` の内部構造だけ変えます。現在 client component 1 枚のところを「サーバー側の記録用の薄い皮（server component）」＋「今まで通りのログインフォーム（client component、中身は無変更）」に分割します。入力欄・ボタン・メール送信フローは変わりません。

### 操作の流れ

**ケース A: ログインしていない人が `/admin` を直接開いた**
1. `/admin` にアクセスする
2. proxy が「未ログイン」と判定し `/login` へ転送する（今まで通り）
3. 転送の応答に、proxy が「ブラウザの JavaScript から読み書きできない、`/login` 宛てだけの短命な印」（httpOnly cookie）を 1 つ載せる。印の中身は「理由＝未認証、経路＝/admin、メソッド＝GET」
4. ブラウザが `/login` を開く。proxy はその要求に印が付いているのを見て、印の中身を**サーバー内部のヘッダに載せ替え**、**応答でその印を消す**（同じ拒否が二重に記録されないため。実装時の発見: 応答で cookie を消すと Next.js は同じリクエストの `cookies()` にも削除を反映するので、Server Component が cookie を直接読むと常に空になる。E2E で発覚）
5. `/login` のサーバー側がそのヘッダを読み、`access_denials` に「guard＝管理画面の入口（proxy_admin）/ reason＝未認証 / 経路＝/admin」の 1 行を記録する。ヘッダは proxy が必ず上書き・削除するので、クライアントは偽装できない
6. 利用者にはいつも通りのログイン画面が表示される（記録が起きたことは画面に出ない）

**ケース B: ログイン済みだが管理者でない人が `/admin` を開いた**
1〜4 は同じ。5 で「reason＝管理者でない」として記録し、「誰が」はログイン中の本人のセッションから取って `actor_id` に入れる（印の中には入れない。理由は「偽造できない仕組み」参照）。

**ケース C: `/api/admin/*` への API 呼び出し**
記録はケース A・B と同じ経路で残ります。「JSON を期待しているのに HTML の `/login` へ転送される」既存の挙動は変えません（下記「今回やらないこと」）。

### 今回やらないこと（スコープ外）

- `/api/admin/*` の API 呼び出しが HTML の `/login` へ転送される問題の修正
- RLS が黙って 0 件を返す「見えない拒否」の記録（P-063 の既存の限界）
- **MFA 登録済みで aal1 のままの非管理者**が `/admin` を試みたケース。proxy は admin 判定より先に MFA ガードで `/mfa-challenge` へ送るため、この経路は記録されません。既知の限界として fail-open 棚卸し F-005 に 1 行残します（人間判断 2 の結果で変わる）
- `/admin/audit` の拒否理由ラベルに `aal2_required` が無く生文字列で出る既存バグ。Sweep が独立に 2 回検出したが、本件と無関係の 1 行修正なので別コミットに切り出す（人間判断 4）

### 受け入れ条件（チェックリスト）

- [ ] 未ログインで `/admin`（または `/admin/xxx`）にアクセスすると `/login` に転送され、`access_denials` に `guard='proxy_admin'`, `reason='unauthenticated'`, `route='/admin'`（実際に叩いたパス）の行が 1 件増える
- [ ] 未ログインで `/api/admin/xxx` にアクセスした場合も同様に 1 件増える（`route='/api/admin/xxx'`, `method` は実際のメソッド）
- [ ] ログイン済み・非管理者で `/admin` にアクセスすると `guard='proxy_admin'`, `reason='not_admin'` の行が 1 件増え、`actor_id` に本人の ID が入る
- [ ] `/login` に直接来た場合、または admin 以外の保護ページから未認証で転送された場合は、この記録は**発生しない**（admin ガードを経由した場合のみ）
- [ ] 転送直後の `/login` を続けて再読み込みしても、同じ拒否の記録は 1 件のまま増えない（proxy が印を消すため）
- [ ] URL のクエリ文字列や `document.cookie` から拒否理由を偽装しても記録に反映されない。想定外の形の印（JSON でない・理由が 2 語以外・経路が 200 文字超や制御文字入り）は記録せず、ログイン画面はそのまま出る
- [ ] `access_denials` への記録に失敗しても（DB 障害等）、`/login` の表示は今まで通り成功する（記録は付随情報でリクエストを止めない）
- [ ] `/admin/audit` の「拒否」タブで、上記の記録が「管理画面の入口」「未認証」/「管理者でない」という日本語ラベルで表示される

### 偽造できない仕組み（設計判断）

- URL 引数（例 `/login?reason=not_admin`）は誰でも開けるので採用しない。
- 印は proxy の転送応答に載せる `httpOnly` cookie（`path=/login`、`sameSite=lax`、本番は `secure`、`maxAge` 10 秒）。ブラウザの JavaScript からは読み書きできない。
- **限界（明記して受け入れる）**: httpOnly は JavaScript からの読み書きを防ぐだけで、curl 等で任意の cookie を送ること自体は防げない。そのため、印の中身は「理由・経路・メソッド」の 3 つに限り、`actor_id` は **`/login` のサーバー側がそのリクエストのセッションから取る**。偽造しても付けられるのは「自分自身（または匿名）の拒否記録」だけで、他人に濡れ衣を着せることはできない。**実装後の直接攻撃の実測（2026-09-13）**: 偽の `not_admin` はセッションが無いと記録されず（actor_id を取れずスキップ）、偽の `unauthenticated` だけが actor_id NULL の匿名行として残る。偽のヘッダは proxy が削除し記録されない。経路の文字列は偽造できるので、長さ 200・制御文字なしを検証してから記録する（201 文字は不記録を実測）。署名（HMAC）は Edge で共有鍵を持つことになり、今回の被害範囲（自分の拒否記録を増やせるだけ）に対して割に合わないため入れない。
- 重複記録は「`/login` 要求に印が付いていたら proxy が応答で消す」ことで防ぐ。Server Component は cookie を書けないので、消す役は proxy にしか置けない。

---

## Part 2 — 実装計画（AI 用・レビュー不要）

### TRI/RISK 判定

`src/proxy.ts`、`src/lib/security/` 配下、`src/app/login/` に触るため **RISK=はい・M/L レーン**。Phase 1 は `aidd-1-1-deep-task` を通した（wf_57bc218f-fe0、72 エージェント、生存 32 件・ギャップ 6 件を統合済み）。

### 実読で確定した事実（実装の前提）

- `src/proxy.ts` は **未認証ガード（`if (!user && !PUBLIC_PATHS...)`）→ MFA ガード → admin ガード**の順に評価し、各段で return する。admin ガード内の `if (!user)` は到達しないデッドコード。**ケース A の印は未認証ガードの分岐で付けなければならない**（`isAdminPath` の判定を未認証ガードより前に上げる）。
- MFA ガードが admin ガードより先なので、aal1 未昇格の非管理者は admin 判定に到達しない（スコープ外に明記）。
- `src/app/login/page.tsx` は全体が `'use client'`。Server Component 化は新規構造の追加。
- `access-denial.ts` の `serviceRoleClient()` は `SUPABASE_SERVICE_ROLE_KEY` の有無だけを見る。新設する `page.tsx` に `runtime` 指定を入れない（Node 既定のまま）。
- migration 20260907000002 の CHECK は guard と reason が独立した IN 句で、組み合わせの制約は無い。`'proxy_admin'` × `'unauthenticated'` / `'not_admin'` は通る。
- `DenialGuard` / `DenialReason` に `'proxy_admin'`・`'unauthenticated'`・`'not_admin'` は定義済み。**新しい値の追加ではない**（予約値を初めて使う）。

### 実装セット一覧（依存順）

**Set A: 印の定義と検証**（依存なし）
- 触るファイル: `src/lib/security/denial-headers.ts`（名前だけのファイルなので Edge / Node 両方から読める。既存コメントの方針を踏襲）
- 内容:
  - `DENIAL_COOKIE_NAME = 'aidd-denial'` を追加
  - 印の型 `ProxyDenialPayload = { reason: 'unauthenticated' | 'not_admin'; route: string; method: string }`
  - `encodeProxyDenial(payload): string`（`JSON.stringify`）と `parseProxyDenial(raw: string | undefined): ProxyDenialPayload | null`。parse は zod（既に本番依存にある）で形を検証し、reason が 2 語以外・route が 200 文字超・route/method に制御文字（0x00–0x1f, 0x7f）を含む・JSON でない、のいずれかなら `null`。route は 200 文字で切らずに**拒否**する（切ると偽装の痕跡が消える）
  - `method` は分析用（GET と POST の並びを見る）で判定には使わない、とコメント
- テスト観点: [型/純関数] `src/lib/security/__tests__/denial-headers.test.ts`（新規）。正常 2 語、JSON でない、reason 不正、route 201 文字、制御文字入り、undefined → 期待どおり null / 値

**Set B: proxy が印を付け、`/login` で消す**（依存: Set A）
- 触るファイル: `src/proxy.ts`、`src/__tests__/proxy.test.ts`
- 内容:
  - `isAdminPath` の判定を未認証ガードの前に移す
  - 未認証ガードで `isAdminPath` のときは、`/login` への redirect 応答に `DENIAL_COOKIE_NAME` を `{ reason: 'unauthenticated', route: pathname, method: request.method }` で載せる。cookie 属性: `httpOnly: true, sameSite: 'lax', path: '/login', maxAge: 10, secure: process.env.NODE_ENV === 'production'`
  - admin ガードの `!isAdmin` 分岐も同様に `reason: 'not_admin'` で載せる。デッドコードの `if (!user)` は削除する
  - `pathname === '/login'` かつ要求に `DENIAL_COOKIE_NAME` があれば、`forwardedHeaders()` がその中身を転送リクエストの `DENIAL_PAYLOAD_HEADER`（`x-aidd-denial`）に載せ（無ければ同名ヘッダを削除）、`supabaseResponse.cookies.set(DENIAL_COOKIE_NAME, '', { maxAge: 0, path: '/login' })` で消す。**Server Component は cookie ではなくこのヘッダを読む**（応答での削除が `cookies()` に先回りするため。実装時に E2E で発覚した修正）
  - cookie を付ける処理は try/catch で包み、失敗しても redirect は返す（fail-open の層 1）
  - MFA ガード・PUBLIC_PATHS の通常転送には付けない
- テスト観点（既存の `proxy.test.ts` の書き方に合わせる）:
  - 未ログインで `/admin` → 307、`set-cookie` に `DENIAL_COOKIE_NAME`、`HttpOnly`、`Path=/login`、値を parse すると `reason='unauthenticated'`, `route='/admin'`
  - 未ログインで `/api/admin/xxx`（POST）→ 同様に `route='/api/admin/xxx'`, `method='POST'`
  - ログイン済み非 admin で `/admin/xxx` → 307、`reason='not_admin'`
  - 未ログインで `/facilities`（admin 以外）→ 307 だが `DENIAL_COOKIE_NAME` は**付かない**（回帰）
  - ログイン済み admin で `/admin` → 通す・cookie なし
  - `/login` に印付きで来る → 通す、応答の `set-cookie` に `Max-Age=0` の削除がある
  - `/login` に印なしで来る → 削除の `set-cookie` は**出ない**

**Set C: `/login` を Server Component の皮＋既存フォームに分割**（依存: Set A。Set B とファイルが被らないので並列可）
- 触るファイル:
  - 新規 `src/app/login/LoginForm.tsx`（現在の `page.tsx` の中身をそのまま移動。`'use client'`、ロジック無変更）
  - 変更 `src/app/login/page.tsx`（async Server Component）。`headers()` で `DENIAL_PAYLOAD_HEADER` を読み `parseProxyDenial` に通す。`null` なら何もしない。値があれば、`reason === 'not_admin'` のときだけ `@supabase/ssr` の `createServerClient`（他の Server Component と同じ `cookies()` ベースの作り）で `getUser()` し `actorId` を取る（`unauthenticated` は `actorId` なし）。`recordAccessDenial({ guard: 'proxy_admin', reason, route, method, actorId })` を呼び、その後 `<LoginForm />` を返す
  - fail-open の層 2・3: `cookies()` 自体の例外、parse の失敗、`getUser()` の失敗、`recordAccessDenial` の例外はそれぞれ別の try/catch で捕まえ、`logServerError('proxy_admin_denial_skip', …)` に区別できる理由（`cookie_unreadable` / `payload_invalid` / `session_unavailable`）を残して描画は続ける。`recordAccessDenial` は内部で握りつぶす設計なので追加の catch は保険
  - `runtime` の指定は書かない（Node 既定）
- テスト観点: [UI/データ取得層] `src/app/login/__tests__/page.test.tsx`（既存を新構造に合わせて更新）
  - 印なし → `recordAccessDenial` が呼ばれない
  - 印 `unauthenticated` → `{ guard: 'proxy_admin', reason: 'unauthenticated', route, method }` で呼ばれ、`actorId` は undefined
  - 印 `not_admin` → `actorId` にセッションの user id
  - 印が壊れている（JSON でない / route 201 文字）→ 呼ばれず、`LoginForm` は描画される
  - `recordAccessDenial` が throw → `LoginForm` は描画される
  - `SUPABASE_SERVICE_ROLE_KEY` がある環境で no-op にならないこと（`serviceRoleClient` が生成されること）は既存の `access-denial.test.ts` の範囲。ここでは呼び出しの有無だけを見る
  - 既存の `LoginForm` のテストは移動先に合わせて import を直すだけ

**Set D: `access-denial.ts` の限界コメント更新**（依存: Set B・C 完了後。文言のみ）
- 22–27 行目の「proxy.ts が admin パスを /login へリダイレクトする経路は…未記録」を削除し、「記録は `/login` の Server Component が印を読んで行う。印は偽造できるが actor_id はセッション由来なので他人に付けられない。MFA 未昇格の非 admin は MFA ガードで先に止まるため未記録」に置き換える

**Set F: ドキュメント更新**（依存: Set B・C 完了後。互いに別ファイルで並列可）
- `docs/agents/promise-catalog.md` P-063 の限界列: 「proxy が /login へ返す admin 経路と RLS の 0 件は未記録」→「RLS の 0 件は未記録。proxy の admin 経路は `/login` の Server Component 経由で記録（印は偽造可能だが actor_id はセッション由来）。MFA 未昇格の非 admin は未記録」。テスト列に Set B・C・G のファイルを足す
- `docs/agents/fail-open-inventory.md` F-005: 「admin ガードの転送に拒否の記録が付随する。記録の 3 層（印の付与 / 印の読み取り / RPC）はいずれも fail-open、判定は fail-closed のまま」。MFA 未昇格の非 admin が未記録である限界を 1 行
- `docs/agents/access-path-inventory.md` X-022: 「proxy の admin 拒否は access_denials に残る」を追記。X-011 は読み取り監査の話なので触らない
- `docs/agents/security-test-catalog.md` に「計画 #757-24」の該当があれば状態を更新

**Set G: E2E**（依存: Set A〜C 完了後。proxy → Server Component の越境は単体では検証できない）
- `e2e/admin-audit.spec.ts` に追記（新規ファイルは攻撃 spec の隔離設定に引っかかるので既存へ）
  - (a) 未ログインで `/admin` を開く → `/login` に着地 → service role で `access_denials` を数え、`guard='proxy_admin'`・`reason='unauthenticated'`・`route='/admin'` が 1 件増えている。**続けて `/login` を再読み込みしても件数が変わらない**
  - (b) 非 admin でログインし `/admin` を開く → `reason='not_admin'`、`actor_id` がその利用者
  - (c) 非 admin は `/admin/audit` でその行を読めない（RLS。記録の成功とは別のアサーション）

### 並列グループ宣言

- 波 1: Set A
- 波 2（Set A 完了後、同時実装可）: Set B / Set C
- 統合ゲート: Set B（書く側）と Set C（読む側）が `denial-headers.ts` の同じ `encodeProxyDenial` / `parseProxyDenial` を import していることをコードレビューで確認する（形の解釈がずれると黙って記録漏れになる唯一の点）
- 波 3（統合ゲート後）: Set D / Set F / Set G

### 型・データアクセス層の方針

- `DenialGuard` / `DenialReason` は変更なし。新しい列挙値ではない
- 判定基準: `reason='unauthenticated'` は proxy が user を null と判定したときだけ、`'not_admin'` は user はいるが `resolveIsAdmin` が false のときだけ。proxy の分岐がそのまま排他になる。`/login` 側は zod で 2 語以外を拒否する
- 下流: `/admin/audit` は GUARD_LABEL / REASON_LABEL に無い値を生文字列で出す既存仕様。`proxy_admin` のラベルが既にあるかは Set F の作業時に確認し、無ければ Set C と同じ波で 1 行足す
- 新しいテーブル・カラム・migration は無い。`record_access_denial` RPC をそのまま使う

---

## Part 3 — 仕様レビュー前セルフチェック（AI 用）

- UI モック要否: 見た目・操作の変更なし → 対象外
- Before/After: 対象外
- 新しい型・enum の判定基準: 予約値の初使用。排他条件は上に明記
- 下流の反応: `/admin/audit` の表示のみ。明記済み
- 列挙の自己矛盾: 該当なし
- 信号の意味変更: `recordAccessDenial` の呼び出し元が 1 つ増えるだけ。既存の意味は変えない
- 統合提案のうち採用しなかったもの: 1-5（actorId を印に載せる。偽造で他人に付けられるため）、1-6（route/method をヘッダに一本化。転送後の要求ではヘッダが元の経路を持たない）、1-4 の「/login 側で失効」（Server Component は cookie を書けない。proxy が消す形に置換）、1-11 の DB 側 UNIQUE（proxy が消す形で重複を防ぐため不要。人間判断 3）
