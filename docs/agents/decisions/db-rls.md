# 設計判断の記録: DB・RLS・データ衛生

[`../decisions.md`](../decisions.md) からの分野別分割（issue #491）。DBスキーマ・RLS施設分離・スキーマドリフト検知・テスト環境データ衛生に関する「なぜその設計にしたか」の記録。各エントリ冒頭の太字1行が結論、以下が背景・理由。

## なぜ施設分離をRLS + is_facility_member関数で実現したか

**結論: アプリ層のif文チェックではなくDB層のRLSで施設分離を強制する。**

`user_facilities` テーブルでユーザーと施設の対応を管理し、`is_facility_member()` を
すべての施設固有テーブルのRLSポリシーで使う設計にした。

アプリケーション層のif文でfacility_idをチェックする方式だと、チェック漏れのエンドポイントが
1つでもあれば他施設のデータが見えてしまう。RLSをDB層に置くことで、どのAPIルート・どのクエリ
経路を通っても機械的に遮断される。

## なぜ管理者判定をDB role（user_facilities.role）ベースにし、ADMIN_EMAILSは初回ブートストラップ専用に限定したか

**結論: 管理者判定はDBの`user_facilities.role`を正とする。`ADMIN_EMAILS`環境変数は、DBにadminが1件も存在しない場合（＝初回デプロイ直後でまだ誰も管理者を割り当てられない状態）のみのブートストラップ用フォールバックとして残す。DBに1件でもadminが存在すれば、`ADMIN_EMAILS`は他の誰に対しても一切参照されない。**

当初 `ADMIN_EMAILS` 環境変数によるフォールバックがあったが、`requireAdmin()` の判定を
DBの `user_facilities.role = 'admin'` ベースに一本化した（`docs/specs/admin-role-migration.sql`）。

環境変数ベースだと、デプロイ環境ごとに設定がずれる／環境変数の変更履歴がgit管理されない
という問題があった。DBに判定根拠を置くことで、管理者の追加・削除がSQLとして履歴に残る。

ただし新規デプロイ直後はDBにadminが1件も存在せず、誰もUIから管理者を割り当てられない
「鶏と卵」問題が残る。issue #24対応（`src/lib/admin-status.ts`、`get_admin_status` RPC）で
この初回ブートストラップ専用の用途に限定して`ADMIN_EMAILS`を復活させた。DBに1件でも
adminが存在する場合は`db_has_admin`判定により`ADMIN_EMAILS`のチェック自体を行わないため、
「一本化」の原則（判定根拠はDBが正）自体は崩していない。この設計は
`src/lib/__tests__/admin-status.test.ts`のテストケースで固定されている。

## なぜprice_historiesはdistributor_product側の施設チェックを素通りさせるか

**結論: `distributor_product`側の価格履歴は施設非依存の共通マスタなのでRLSチェックを素通りさせ、`hospital_price`側のみ`is_facility_member`でチェックする。**

`price_histories` のRLSは `entity_type = 'distributor_product'` の場合は無条件で `true` を返す
（`hospital_price` の場合のみ `is_facility_member` でチェックする）。

`distributor_product` は施設非依存の共通マスタであり、その価格変更履歴も全施設で共有する
情報だから。`hospital_price` は施設固有の価格なので、そちらだけ施設チェックが必要。

## なぜDBスキーマ変更をmigrationファイル経由に限定し、直接DDL実行を禁止したか

**結論: `supabase/migrations/`配下のファイル経由のみを正とし、`execute_sql`等の直接DDL実行を禁止する。**

過去に `execute_sql` 等でリモートDBに直接適用されたイベントトリガー（`rls_auto_enable` /
`ensure_rls`）が、どのmigrationファイルにも記録されていないスキーマドリフトとして発覚した
（`20260707000001_capture_rls_auto_enable_event_trigger.sql` で復元・記録）。

migrationファイルだけがスキーマの唯一のソースオブトゥルースであるべきで、直接DDL実行を
許すとローカル・リモート・disaster recoveryの間でスキーマが一致しなくなる。この事例を機に、
直接実行を禁止し、既存の未記録スキーマ変更を見つけた場合は必ずキャッチアップmigrationとして
記録するルールにした。

## なぜE2E/BSGはテスト専用Supabaseのみに接続する設計にしたか

**結論: `NODE_ENV=test`時は本番接続情報を読み込ませず、実行時にも接続先を機械的に検証する多層防御にする。**

`NODE_ENV=test` では `.env.local`（本番接続情報）を読み込ませず、`e2e/env-guard.ts` で
許可ホスト以外への接続を即失敗させる多層防御にしている。

E2Eテストやシード投入は本番相当の操作（データ作成・削除・RLSトリガー実行）を伴うため、
設定ミス1つで本番DBに書き込まれるリスクがある。環境変数の設定ミスだけに頼らず、実行時に
接続先を機械的に検証することで、ヒューマンエラーが起きても本番事故に直結しないようにした。

## なぜスキーマドリフト検知を自前cronではなくSupabase GitHub Integrationで始めたか

**結論: 本番のアクセストークンをGitHub Secretsに置く自前cronは既存方針と矛盾するため、Supabase公式GitHub Integration（検知のみ・デプロイ自動化はOFF）を採用した。**

`supabase db diff --linked` を独自のGitHub Actions cronで定期実行する案（issue #30原案）も
検討したが、これは本番の `SUPABASE_ACCESS_TOKEN` とDBパスワードをGitHub Secretsに追加する
必要があり、e2e.ymlが徹底している「CIに本番Supabase接続情報を一切渡さない」方針
（本ファイルの「なぜE2E/BSGはテスト専用Supabaseのみに接続する設計にしたか」）と正面から
矛盾する。

Supabase公式のGitHub Integration（Dashboard側でOAuth認可するだけで、GitHub Secretsへの
手動登録が不要）を先に有効化する方針にした。「Deploy to production」（mainマージで本番DBへ
自動でmigrationを適用する機能）はOFFのままにしている。issue #30の目的は検知であって
デプロイ自動化ではなく、AIDD品質ゲート（重大度分類のImplement/Integrateゲート組み込み）が
未実装の段階で、最もクリティカルな変更であるDBスキーマ変更を自動デプロイの対象にするのは
時期尚早と判断した。調査の結果、これまでも本番へのmigration適用はCIではなくローカルCLIでの
手動 `supabase link` → `supabase db push`（都度確認付き）で行われており、Integrationを
ONにすることは既存フローの自動化ではなく新規のリスクを追加することになる、という点も判断
材料にした。

GitHub側で「required status check」によるマージブロックも検討したが、このリポジトリは
private repoでGitHub Free（Org）プランのため、classic branch protectionもRulesets（新機能）も
「強制」が有効にならないことが判明した（プライベートリポジトリでの強制にはGitHub Team以上の
プランが必要）。有償プランへのアップグレードは費用判断のため今回は見送り、Supabaseの
ステータスチェックがPR画面に表示される「検知のみ」の状態を許容する方針にした。マージの
可否は引き続き人間のレビューに委ねる。

弱点として、PRを介さない変更（SQL Editor等での直接操作、rls_auto_enableの実際の事故
パターン）はPRが発生するまで検知が遅延する。この「PRの外側の変更」をどう定期検知するかは
未解決のまま残しており、シークレットをGitHub側に置かない代替案（Supabase Edge Functionの
スケジュール実行など）を含めて別issue（#305）で検討する前提にしている。

## なぜマスタデータ（products/categories/distributor_products）の書き込みをadmin限定にしたか

**結論: マスタデータのINSERT/UPDATE/DELETEはadmin限定にし、SELECTのみ全認証ユーザーに許可する。**

`20260629000001_fix_master_rls.sql` で、これらのテーブルのRLSを「SELECTは全認証ユーザー可、
INSERT/UPDATE/DELETEはadmin（`is_admin()`）のみ可」に変更した。それ以前は `auth_only` という
FOR ALLポリシー（`USING (true) WITH CHECK (true)`）で、書き込みも全認証ユーザーに許可されて
いたが、これは設計意図と一致しない状態だった（`SPEC-tech-debt.md` SET F、2026-06-29）。

マスタデータ（製品・カテゴリ・代理店製品）は施設横断で共有される単一の真実源であり、
どこか1施設のスタッフが自由に編集できると、他の全施設の在庫管理・発注に影響する。書き込みを
admin限定にすることで、共有マスタの一貫性を管理者の統制下に置く設計にした。

**教訓（2026-07-13、issue #39のSPEC.mdレビューで発覚）:** この決定がdecisions.mdに記録されて
いなかったため、後続のSPEC.md（在庫マスタへのカラム追加）が「管理者・施設スタッフ双方が
登録・編集できる」という汎用テンプレート文言のまま受け入れ条件に書かれ、E2Eテストが実際の
CI（本番相当RLS）で初めて失敗するまで気づかれなかった。**SPEC.mdの受け入れ条件でマスタデータ
（products/categories/distributor_products等）のCUD操作に触れる場合は、着手前にこのセクションと
該当migrationの `-- WHY:` コメントを必ず確認すること。**

## なぜ発注系RPC 4関数のみsearch_path=''+完全修飾にし、他のSECURITY DEFINER関数は据え置いたか

**結論: `create_case_order_atomic`/`create_loan_order_atomic`/`create_consumable_order_atomic`/`resolve_jan_unit_price`の4関数を`SET search_path = ''`＋全参照`public.`完全修飾に変更した（`20260804000001_harden_order_rpc_search_path.sql`）。`is_facility_member`・`get_distributor_product_price_history`等、他の既存`SECURITY DEFINER`関数は`SET search_path = public`のまま据え置いている。**

`SET search_path = public`のままだと、`SECURITY DEFINER`関数は理論上、呼び出し元セッションが
`public`より前に別スキーマを検索パスに追加していた場合の名前解決に依存する余地が残る
（search_path hijacking）。`search_path = ''`＋全オブジェクトの完全修飾にすれば、名前解決が
実行時のセッション設定と無関係に固定される。

今回はSupabase機能のハンズオン学習として発注系4関数のみをスコープにした。したがって
**このリポジトリの`SECURITY DEFINER`関数は`search_path=public`（旧方式）と`search_path=''`
＋完全修飾（新方式）が混在した過渡状態にある。** 新規に`SECURITY DEFINER`関数を書く場合は
新方式（`search_path=''`＋完全修飾）を採用し、他の既存関数（`is_facility_member`・
`get_distributor_product_price_history`等）を横展開で新方式に揃えるかどうかは、範囲が
広がるため別途判断すること。

検証は、変更対象4関数の中に拡張機能（`extensions`スキーマ）由来の関数呼び出しがないこと
（`gen_random_uuid()`は各テーブルの`id`列`DEFAULT`としてDDL側でのみ使用されており、
CREATE TABLE時に関数OIDへ解決済みのため`search_path`変更の影響を受けない）を確認したうえで、
ローカルSupabaseへ実際に`db push`し、実DB統合テスト（`order-repositories.integration.test.ts`
ほかRLS/IDOR統合テスト計6ファイル・22件）が全て通ることまで確認した。静的なSQLテキスト検証
（`__tests__/harden_order_rpc_search_path.test.ts`）だけでは、スキーマ修飾漏れによる実行時
エラーは検知できないため、実DBでの検証を省略しないこと。

## なぜスキーマドリフト検知（issue #305）にEdge Functionを使わずpg_cron + GitHub Actionsポーリングを採用したか

**結論: リアルタイムEdge Function通知案は未確認依存が多く不採用。pg_cronでDB内部に記録し、通知はGitHub Actionsの日次ポーリングに委譲する構成にした。**

issue #305（PRを介さない本番スキーマ変更の定期ドリフト検知）は、Phase 1深掘り調査（98エージェント）
のJudge Panelが「最小スコープv1設計」を採用推奨案として選定した。Edge Function + pg_net経由の
リアルタイム通知案は、pg_net拡張の有無が未確認・Edge Functionのデプロイパイプライン未定義・
GITHUB_TOKENのSupabase環境変数管理という3つの未確認依存を抱えており、v1では不採用とした。

代わりに、DB内部（pg_cron）が`check_schema_drift()`を毎日呼んで`schema_drift_log`に記録するだけに
とどめ、通知はGitHub Actionsの日次ポーリング（`drift_alert_view`をanon keyで読み、`gh issue create`）
に委譲する構成にした。これによりSUPABASE_ACCESS_TOKEN・DBパスワード・service role keyのいずれも
GitHub Secretsに置く必要がなくなり、既存方針（本ファイル冒頭「なぜE2E/BSGはテスト専用Supabase
のみに接続する設計にしたか」等）と完全に整合する。

**実装時に発覚した矛盾とその解決:** 仕様ドラフトでは、GitHub Actionsが作成したIssue URLを
`record_issue_url()` RPC経由でDBに書き戻す設計だったが、その関数はservice_role限定であり、
anon keyのみで動くGitHub Actionsからは本来呼び出せない（「本番接続情報をGitHub Secretsに置かない」
という制約と直接矛盾する）。この矛盾はPhase 2の仕様レビュー（Part 3セルフチェック）でも見逃され、
Phase 3の実装時（db-impl・api実装担当がそれぞれ別々にSPECを読んだ際）に初めて発覚した。

解決として、DBへの書き込みを一切行わない設計に変更した。GitHub Issueのタイトルを
`[schema-drift] <drift_type>: <object_name>`という決定的な形式にし、既存のopen issueとの
タイトル突合だけで冪等性（重複作成防止）とクローズ判定を実現する。GitHub Issue自体を
状態源（state source）とすることで、Supabase側への書き込み権限が一切不要になった。

**教訓:** 「anon keyのみで完結させる」という制約は、通知の"作成"だけでなく"状態更新（書き戻し）"
にも同じ制約がかかることをSPEC作成時点で見落としやすい。read-onlyなanon key経由の設計を書く際は、
「この設計のどこかにwrite操作が紛れ込んでいないか」をPart 3セルフチェックの追加観点として
確認すべきだった（現行のPart 3チェックリストにはこの観点が明示的に含まれていない）。
