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

## なぜJWTのuser_roleクレーム（issue #602）をUIゲーティング専用に限定し、認可判断には使わないことにしたか（issue #610）

**結論: `user_role`クレームはUIゲーティング専用（ボタンの表示/非表示等のUXヒント）とし、認可判断には一切使わない。RLS/RPCは引き続きJWTクレームを参照せず、`auth.uid()`から`user_facilities`テーブルを都度引き直して施設ごとに認可を再判定する既存設計を維持する。**

`20260805000002_add_custom_access_token_hook.sql`のCustom Access Token Hookは、ユーザーが所属する
全施設のロールを`bool_or`で集約し、単一の`user_role`クレームとしてJWTへ埋め込む。この集約方式には
構造的な曖昧さがある: 施設Aのみadminで施設Bではstaff（またはメンバーですらない）ユーザーの場合、
クレームは「admin」を返す。施設Bの画面文脈でこのクレームを見ても、そのユーザーが施設Bでadmin
権限を持つとは限らない。

認証・RBAC設計の多角的評価（2026-08-06）でこの曖昧さを指摘したが、実装時点で`user_role`クレームは
アプリケーションコード（`src/`配下）のどこからも参照されていないことを`grep`で確認した。使われて
いない以上、実害は今のところ存在しない。

この「実害なし」という判断は、**RLS/RPCがJWTクレームを一切消費していないことに依存した、条件付きの
正しさ**である。`is_facility_member`・`is_facility_writer`はいずれも`auth.uid()`から`user_facilities`
テーブルを都度引き直し、対象行自身の`facility_id`列と突き合わせて判定する（`p_facility_id`引数に
対象行のfacility_idを渡すRLSポリシー・RPC呼び出しパターンを`20260627010000_add_multitenant.sql`・
`20260805000001_add_viewer_role.sql`のRLSポリシーとRPC本体で確認済み）。つまり施設Aのadminが施設Bの
行に対して書き込もうとしても、`is_facility_writer(facility_id)`は施設Bの`facility_id`で再判定される
ため、JWTクレームの曖昧さが実際の認可結果に影響することはない。

このため、以下の2点を対応方針として確定した:
- `user_role`クレームは「UIゲーティング専用・認可判断には使わない」という用途制限を、Custom Access
  Token Hook自体の定義（`20260805000002_add_custom_access_token_hook.sql`のコメント）に明記する。
- クレームを削除せず残す判断にしたのは、YAGNIで一度削除すると、issue #608（viewerロールのUI
  ゲーティング実装）で似た構造の判定材料が改めて必要になり手戻りが大きい一方、現状クレームを
  残すコストはゼロだから。

**前提が崩れる条件:** この「実害なし」判断はRLS/RPCがJWTクレームを一切参照しないという現在の実装
に強く依存している。将来、誰かが認可判断（RLSポリシーやRPC内の`IF`文）で`auth.jwt()->>'user_role'`
を直接参照するようになった場合、この判断は無効になる。認可判断でJWTクレームを参照するコードを
追加する際は、必ずこのセクションを読み直し、`user_role`クレームの施設非依存な集約方式（bool_or）が
その用途に耐えるか再検証すること。

## なぜaal2要求（issue #612）をRPC内チェックだけでなくRLSポリシー自体にも追加したか（issue #623）

**結論: `facility_writer_or_admin`ポリシーが付与されている全テーブル（発注/返却4テーブル・items系4テーブル・`hospital_prices`・`consumables`）のRLSポリシー自体に`has_aal2()`を追加した（`20260806000002_require_aal2_in_facility_writer_rls.sql`）。`facilities`（UPDATE、施設名変更のみ）は対象外とした。**

`20260806000001`（issue #612）で`create_case_order_atomic`等4つのRPC関数の**内部**に`has_aal2()`
チェックを追加したが、これらのテーブル自体のRLSポリシーは`is_facility_writer(facility_id) OR
is_admin()`のみで、aal2判定を一切含んでいなかった。Next.jsアプリは常にRPC経由で発注するため
気づかないが、PostgRESTの`POST /rest/v1/case_orders`のようにRPCを経由せずテーブルへ直接INSERT
すれば、aal1のセッションのままでも発注データを書き込める。issue #612が「middlewareを迂回して
直接Supabase APIを叩く経路をDB層で塞ぐ」ことを目的としていたにもかかわらず、発注テーブル自体の
RLSではこの経路が塞がっていなかった（RPC内チェックのみでは、RPCを経由しない直接書き込みを
防げない）。

対象範囲は、issue #619（hospital_prices・consumablesがaal2要求の対象外という指摘）の議論を
本issueで吸収し、以下のように確定した:
- 発注/返却4テーブル・items系4テーブル: #612の防御を完成させるために必須（バグ修正）
- `hospital_prices`・`consumables`: 価格改定は金額に直結し、かつ発注同様に低頻度の操作と判断し
  対象に含めた。`consumables`テーブルは在庫数列を持たず`name`/`jan`/`purpose`のみのカタログで
  あり、頻繁な編集を想定した運用ではないことを`supabase/migrations/20260624000000_add_orders.sql`
  のスキーマ定義で確認済み。
- `facilities`（UPDATE）: 対象外。金額・在庫の移動を伴わない純粋な管理操作であり、issue #612の
  「金額・在庫に影響する書き込み操作に限定する」という線引きに該当しないため。

RPC内の既存`has_aal2()`チェックは冗長になるが削除しなかった。RLSとRPC両方でのチェックは
defense-in-depthとして、このリポジトリの既存パターン（`is_facility_writer`もRLSとRPC両方で
チェックしている）と一致するため。

検証は、静的SQLテキスト検証に加え、実際のTOTP enroll→challenge→verifyフローを実行する統合テスト
（`supabase/__tests__/integration/require-aal2-in-facility-writer-rls.integration.test.ts`）で
「MFA登録済み・aal1のセッションでは`case_orders`・`hospital_prices`への直接INSERT（RPC非経由）が
拒否される」「aal2まで昇格すると成功する」「`facilities`の更新はaal1のままでも成功する（対象外の
回帰確認）」を実測した。RPC経由の防御だけを見て「実装済み」と判断せず、RLSポリシー自体が同じ
チェックを持つかを都度確認すること。

## なぜRLS/IDORゲート（e2e.ymlのtest:integration）の誤差許容率を「0%」と明文化したか（OBL7評価設計タスク）

**結論: RLS/IDORの統合テスト（`e2e.yml`の`test:integration`ステップ）は既にPRごとに実行されているが、合否ラインが暗黙のままだったため「1件でも失敗したらred、再試行による許容なし」と明記した。**

[[なぜtest/lintゲートの誤差許容率を「0件」に設定し、既存のCI job（ci.yml→node-check.yml経由）に
lintの--max-warnings=0を追加したか（OBL7評価設計タスク）]]と同じmentor指摘（346万トークン消費の
ルーター誤判定インシデント）を受けた棚卸しで、RLS側は「静的チェック」という名目のゲートが実質
存在しない一方（`.claude/security-patterns.json`はreminderのみでブロックしない、
`schema-drift-check.yml`は本番監視の事後通知でPRゲートではない）、`e2e.yml:58-59`の
「RLS/IDOR integration tests」（`npm run test:integration`）が実質的なRLSゲートとして
既に全PRで実行されていることを確認した。

この既存jobに対し、以下を合否ラインとして明記する:

- テナント越境アクセス・IDOR系のテストは**1件でも失敗したらCI red**とし、許容率0%とする
  （セキュリティ境界のテストであり、test/lintと異なり「たまたま失敗」を許容する理由がない）
- ブラウザ操作特有の一過性の不安定さ（要素待機タイムアウト等）については
  `playwright.config.ts:17`のCI内1回リトライのみ許容し、2回連続失敗した場合は
  実装側の問題として扱う（test/lint側のエントリと同じ位置づけ）

[[なぜCI品質ゲートの失敗が赤バツ表示止まりで、マージボタン自体は止められないか]]の制約により、
これもPR上の可視化止まりであり、マージの機械的ブロックではない。

**How to apply:** RLS/IDOR系のテストを新規追加する際は、このエントリの「0%許容」を
デフォルトの合否ラインとして踏襲する。緩める場合（例: 既知のflaky個別ケースを一時的に
skipする等）は、その理由と再検証タイミングを本エントリに追記してから行う。
