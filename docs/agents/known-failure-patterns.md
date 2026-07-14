# 既知の失敗パターン・チェックリスト

過去に実際に発生した実装ミスを、次に同じコードパターンを書く/レビューする際に
**機械的にチェックする項目**としてここに蓄積する。

`decisions.md` との違い: あちらは「なぜその設計にしたか」という理由の記録。
ここは「このコードを見たら必ずこの項目を確認する」というチェックリストであり、
理由の深掘りはしない（理由が必要ならリンク先の decisions.md エントリを参照する）。

SPEC.md やコードコメントに書くだけでは実装フェーズで見落とされて再発する
（実例: 下記「Suspenseフォールバック」参照）ため、レビュー・Sweepフェーズで
機械的に拾えるようここに置く。

## UI層

### Suspenseフォールバック未設定（useSearchParams使用時）

**チェック内容:** `useSearchParams()` を使うクライアントコンポーネントが、
`<Suspense fallback={...}>` でラップされずにexportされていないか確認する。

**なぜ再発したか:** SPEC.mdに「Suspenseでラップする」と明記されていたにもかかわらず、
実装フェーズで見落とされブランクスクリーン（SSRハイドレーション時の一瞬の白画面）が
発生した実例がある。仕様書に書くだけでは防げないことが実証済みなので、レビュー時に
必ず該当パターン（`useSearchParams`/`usePathname`等の動的APIをトップレベルで呼ぶ
クライアントコンポーネント）を検索し、Suspense境界の有無を確認する。

## データ取得層 / API層

### SECURITY DEFINER + GRANT EXECUTEの認可バイパス

**チェック内容:** 新規・変更されたPostgreSQL RPC関数（`supabase/migrations/*.sql`）が
`SECURITY DEFINER` を付けている場合、必ず以下を確認する：
1. 関数内で `is_facility_member(...) OR is_admin()` 等の明示的な認可チェックを行っているか
2. GRANT EXECUTE の対象ロールが必要最小限か（機微データを返す関数に `anon` を含めていないか）

`SECURITY DEFINER` 関数はRLSをバイパスし、`/rest/v1/rpc/<function>` として
Next.js API Route（`requireFacilityAccess`等）を経由せず直接呼び出せる。
関数の引数（`p_facility_id`等）によるWHERE句の絞り込みは単なるフィルタであり、
「呼び出しユーザーがその施設に所属しているか」を検証する認可チェックではない。

**推奨:** まず「`SECURITY DEFINER` を付けずに済ませられないか」を検討する。
既存テーブルのRLSポリシーが正しく設定されていれば、`SECURITY INVOKER`
（デフォルト）のままでRLSが関数内クエリにも自動適用され、関数内に認可ロジックを
手書きする必要自体がなくなる。同種の既存関数（同じテーブルを横断取得するもの）が
コードベースに既にないか先に探す。

詳細: [`decisions.md`](./decisions.md#なぜ施設分離をrls--is_facility_member関数で実現したか)

### クエリパラメータのバリデーション漏れ（NaN・負数・上限）

**チェック内容:** APIルートで `Number(request.nextUrl.searchParams.get(...))` のように
クエリパラメータを数値変換している箇所を見つけたら、以下を確認する：
1. `Number.isFinite()` チェックがあるか（`NaN`/`Infinity` を弾けるか）
2. 負数を弾いているか
3. `limit` 系パラメータに上限（最大値）があるか（上限なしは大量データ取得によるDoSベクタになる）

`Number('abc')` は静かに `NaN` を生成し、バリデーションなしで下流のクエリ・RPC呼び出しに
渡ると不可解な500エラーや想定外の挙動になる。素の `Number(...)` 変換を見たら、
上記3点を満たすガード節があるか必ず確認する。

## エージェント/hook運用層

### hookから`claude -p`を起動する際のsettings.json/hooks継承漏れ

**チェック内容:** Stop/PreToolUse等のhookスクリプトが検証・裏取り目的で`claude -p`
サブプロセスを起動している箇所を見つけたら、`--setting-sources ""`(または`--bare`)と
`--no-session-persistence`が付いているか確認する。

**なぜ再発したか:** これが無いと、サブプロセス自身のStopイベントで元のhook一式(サブプロセスを
起動したhook自身やグローバルの通知hook等)が継承・再発火し、子プロセスが際限なく増殖する。
2026-07-14に初回発生(15分で343セッション生成)、修正コミットがPR化されずmainに未マージだった
ため2026-07-15に別worktreeで再発した。詳細: [`2026-07-14-verification-subagent-design.md`の
「運用インシデント」節](../superpowers/specs/2026-07-14-verification-subagent-design.md#運用インシデントpostmortem)。

## RLS/テナント分離層

### 「動いたからOK」でfacility_idフィルタ漏れ・RLS未設定を見逃す（issue #24再発防止）

**チェック内容:** facility/tenant/organizationに触れる新規・変更API（`route.ts`のGET/POST/PUT/
DELETE、RPC関数）をレビューする際は、以下を**攻撃者視点**で確認する
（「自分の施設で正常に動く」ことの確認だけでは不十分）：

1. `requireAuth`（未認証拒否）が全メソッドに付いているか
2. `requireFacilityAccess` 相当（呼び出しユーザーが対象の `facility_id` に所属しているか）の
   チェックがあるか。`facility_id` をクエリパラメータ／パスパラメータ／リクエストボディから
   受け取る箇所は、それを鵜呑みにせず検証しているか
3. **実際に他施設・他テナントの実在するリソースID（例: 他施設の `case_order.id`）を渡して
   アクセスし、403/404で拒否されることを目視確認したか。** 「他施設のIDを知らなければ
   アクセスできない」という推測ではなく、実際にIDを渡して弾かれることを確認する
4. `SECURITY DEFINER` 関数を経由する場合は、上記「SECURITY DEFINER + GRANT EXECUTEの認可
   バイパス」の項目も併せて確認する

**なぜ再発したか:** issue #24で、`products/[id]`・`facilities/[id]`・`categories/[id]`・
`distributor-products/[id]`・`hospital-prices/[id]` のGET/PUT/DELETE、
`distributor-products/[id]/price-history` のGET、`consumables` のPOSTに `requireAuth` が
欠落していたことが、実装から時間が経ってから（別issueのPhase 1調査中に）発覚した。
「エンドポイントを叩いて意図通りのデータが返ってきた」という確認だけでは、認証・認可チェック
自体が存在しないケースを検出できない。

**既存の実装パターン:** `case_orders`/`consumable_orders`/`loan_orders` には他施設IDでの
アクセスを実際に試行するRLS/IDOR統合テストが既にある
（`supabase/__tests__/integration/*-rls-idor.integration.test.ts`、
`e2e/cross-facility-boundary.spec.ts`）。facility/tenantに触れる新規テーブル・APIを
追加する際は同種のテストを追加する。

引き継ぎメモの「検証済み」欄には、他テナントIDでのアクセス確認結果を明示する
（詳細は [`common.md`](./common.md#引き継ぎフォーマット) 参照）。
