# 設計判断の記録

「なぜその設計・ルールにしたか」を記録する。ルール本体は `common.md` を参照。
ここは理由だけを書き、実装詳細やハウツーは書かない。

DBスキーマ固有の「なぜ」は、まずそのマイグレーションファイルの `-- WHY:` コメントを正とする。
ここには複数マイグレーション・複数レイヤーにまたがる横断的な決定だけを書く（二重管理を避けるため）。

## なぜdomain.md/decisions.mdを単一ファイルで始めたか

grill-with-docsスキルの `CONTEXT.md` + `docs/adr/`（分野別に分割するパターン）も検討したが、
用語・決定候補がまだ少ない段階（各6〜7件程度）で分割すると、1ファイルに数行しかない
「空気を運ぶだけのファイル」が増えるだけだった。

1ファイルが長くなった、または分野が3つ以上に増えたタイミングで、目次ファイル＋分野別ファイルに
分割し直す前提にしている。単一ファイルのまま無限に肥大化させる想定ではない。

## なぜセッション終了時のドキュメント更新提案を「提案のみ」にし、自動追記にしなかったか

Stop hookでdomain.md/decisions.mdの更新候補を提案する仕組みを作ったが、フックが確認なしで
直接ファイルに書き込む設計にはしなかった。

decisions.mdは「後戻りしづらい・記録がないと後から謎・本当にトレードオフがあった」という
高い基準で厳選する設計にしている。AIの誤判断（ドメイン理解が浅い状態での用語追加、trivialな
変更のADR化等）がそのままファイルに書き込まれると、この基準が形骸化し、ファイルの信頼性が
落ちる。書くかどうかの最終判断は人間が行う。

## なぜ施設分離をRLS + is_facility_member関数で実現したか

`user_facilities` テーブルでユーザーと施設の対応を管理し、`is_facility_member()` を
すべての施設固有テーブルのRLSポリシーで使う設計にした。

アプリケーション層のif文でfacility_idをチェックする方式だと、チェック漏れのエンドポイントが
1つでもあれば他施設のデータが見えてしまう。RLSをDB層に置くことで、どのAPIルート・どのクエリ
経路を通っても機械的に遮断される。

## なぜ管理者判定をDB role（user_facilities.role）ベースにしたか

当初 `ADMIN_EMAILS` 環境変数によるフォールバックがあったが、`requireAdmin()` の判定を
DBの `user_facilities.role = 'admin'` ベースに一本化した（`docs/specs/admin-role-migration.sql`）。

環境変数ベースだと、デプロイ環境ごとに設定がずれる／環境変数の変更履歴がgit管理されない
という問題があった。DBに判定根拠を置くことで、管理者の追加・削除がSQLとして履歴に残る。

## なぜprice_historiesはdistributor_product側の施設チェックを素通りさせるか

`price_histories` のRLSは `entity_type = 'distributor_product'` の場合は無条件で `true` を返す
（`hospital_price` の場合のみ `is_facility_member` でチェックする）。

`distributor_product` は施設非依存の共通マスタであり、その価格変更履歴も全施設で共有する
情報だから。`hospital_price` は施設固有の価格なので、そちらだけ施設チェックが必要。

## なぜTRI/RISK判定を機械判定にし、人の裁量で緩めないことにしたか

`supabase/migrations/` ・`src/lib/supabase/` ・`middleware.ts` ・auth/facility/tenant/
organization/inventory/RLS/policyドメインに触れる変更は、無条件でM/L扱い（RISK=はい）と
common.mdに定めている。

これらは施設間データ越境・権限昇格など、事故った際の被害が大きく後戻りしにくい領域。
「今回は軽微だから」という都度の判断を許すと、判断者によって基準がぶれて事故を防げなくなる
ため、レビュー省略可否の裁量を人間に与えない設計にした。

## なぜDBスキーマ変更をmigrationファイル経由に限定し、直接DDL実行を禁止したか

過去に `execute_sql` 等でリモートDBに直接適用されたイベントトリガー（`rls_auto_enable` /
`ensure_rls`）が、どのmigrationファイルにも記録されていないスキーマドリフトとして発覚した
（`20260707000001_capture_rls_auto_enable_event_trigger.sql` で復元・記録）。

migrationファイルだけがスキーマの唯一のソースオブトゥルースであるべきで、直接DDL実行を
許すとローカル・リモート・disaster recoveryの間でスキーマが一致しなくなる。この事例を機に、
直接実行を禁止し、既存の未記録スキーマ変更を見つけた場合は必ずキャッチアップmigrationとして
記録するルールにした。

## なぜaidd-phase1-router.jsでargsをJSON.parseする防御コードを入れたか

`.claude/workflows/aidd-phase1-router.js` は、`typeof args === 'string'` の場合に
`JSON.parse(args)` してから使う防御コードを持つ。これはスクリプト側のバグ対応ではなく、
**Workflowツール自体の未解決の不具合への回避策**。

実測では、Workflowツールに `args: {"taskDescription": "..."}` をオブジェクトとして渡しても、
スクリプト内で受け取った `args` が `typeof args === 'string'` になる（JSON文字列化された状態で
渡ってくる）ことを診断用スクリプトで確認した。ツールの仕様上は「argsをverbatim（そのまま）で
渡す」とされているが、実際の挙動は仕様と食い違っている。

ツール本体の不具合は自分たちの管理外のため直接修正できない。将来Workflowツール側の実装が
修正された場合、この防御コードは不要になる可能性がある。ただし後方互換のため、修正確認が
取れるまでは外さないこと（`typeof args === 'string'` のガードがあるため、objectで正しく届く
ようになっても副作用なく動作し続ける）。

## なぜE2E/BSGはテスト専用Supabaseのみに接続する設計にしたか

`NODE_ENV=test` では `.env.local`（本番接続情報）を読み込ませず、`e2e/env-guard.ts` で
許可ホスト以外への接続を即失敗させる多層防御にしている。

E2Eテストやシード投入は本番相当の操作（データ作成・削除・RLSトリガー実行）を伴うため、
設定ミス1つで本番DBに書き込まれるリスクがある。環境変数の設定ミスだけに頼らず、実行時に
接続先を機械的に検証することで、ヒューマンエラーが起きても本番事故に直結しないようにした。

## なぜスキーマドリフト検知を自前cronではなくSupabase GitHub Integrationで始めたか

`supabase db diff --linked` を独自のGitHub Actions cronで定期実行する案（issue #30原案）も
検討したが、これは本番の `SUPABASE_ACCESS_TOKEN` とDBパスワードをGitHub Secretsに追加する
必要があり、e2e.ymlが徹底している「CIに本番Supabase接続情報を一切渡さない」方針
（このファイルの「なぜE2E/BSGはテスト専用Supabaseのみに接続する設計にしたか」）と正面から
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

## なぜスキーマドリフト検知（issue #305）にEdge Functionを使わずpg_cron + GitHub Actionsポーリングを採用したか

issue #305（PRを介さない本番スキーマ変更の定期ドリフト検知）は、Phase 1深掘り調査（98エージェント）
のJudge Panelが「最小スコープv1設計」を採用推奨案として選定した。Edge Function + pg_net経由の
リアルタイム通知案は、pg_net拡張の有無が未確認・Edge Functionのデプロイパイプライン未定義・
GITHUB_TOKENのSupabase環境変数管理という3つの未確認依存を抱えており、v1では不採用とした。

代わりに、DB内部（pg_cron）が`check_schema_drift()`を毎日呼んで`schema_drift_log`に記録するだけに
とどめ、通知はGitHub Actionsの日次ポーリング（`drift_alert_view`をanon keyで読み、`gh issue create`）
に委譲する構成にした。これによりSUPABASE_ACCESS_TOKEN・DBパスワード・service role keyのいずれも
GitHub Secretsに置く必要がなくなり、既存方針（本セクション冒頭「なぜE2E/BSGはテスト専用Supabase
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

## なぜ新しい運用ルールに「検知手段を先に決める」原則を導入したか（issue #339）

2026-07-14のmentor設計レビューで、現行ルールの強制力が3層に分かれていることが確認された：

| 層 | 例 | 強制力 |
|---|---|---|
| 機械強制 | env-guard、CI、Stop hook（ai:check実行検知） | 破れない |
| 機械検知（事後） | check-loop-observability-gap.sh、schema-drift検知 | 破ると気づける |
| 自然言語のみ | agent-progress記録、aidd-phase1-routerを入口に使うこと自体、ブランチ運用、引き継ぎフォーマット | 読まれなければ終わり |

第3層は「破られたことに気づく手段」が無く、破られても静かに劣化する。実際に3回壊れた実績がある
（loop-observability記録の5日分欠落、TRI/RISK判定が「機械判定」と明記されつつ実態は手動運用
だった期間、セッションレポートの空テンプレ自動生成）。壊れる条件も既知（コンテキスト圧縮時・
Codex等の別ツール経由・古いworktreeで古い版のルールが読まれるとき）。

common.mdの分量は増え続けており、prose追加1件ごとに他ルールの遵守率が薄まる構造的問題がある
（読む分量が増えるほど、1件あたりの遵守確率は下がる）。これに対し「もっと詳しく書く」で対応
すると悪化するだけなので、書く量を増やす方向ではなく検知できるものは機械に移す方向で対応する
方針にした。

**原則:** 新しい運用ルールは、破られたことを機械的に検知する手段を先に決めてから書く。検知手段を
設計できないルールは、prose追加ではなく既存の機械ゲート（hook / CI / スクリプト）の拡張として
実装できないか先に検討する。検知すら設計できない場合は、そのルールがprose追加に見合う価値を
持つか自体を疑う。検知（事後）で十分なものと、強制（事前ブロック）が必要なものは分けて設計する
（例: 停止①の人間承認はManifest Checkによる事前ブロック、agent-progress記録漏れは事後の件数
突合で十分、という判断の違い）。

すべてを一度に機械化する必要はない。まず第3層ルールの棚卸し（[`common.md`](./common.md)参照）
と本原則の明文化だけでも、ルール増殖の歯止めになる。個別の検知手段のうち、agent-progress記録漏れ
検知は`scripts/check-agent-progress-gap.sh`（loop-observabilityのgap検知と同じ「期待件数 vs
実測件数」パターンを再利用）として実装済み。残る2件（router非経由でのTRI/RISK対象変更検知、
引き継ぎフォーマット実施検知）は優先度順に別途実装する（未着手、issue #339）。

**追記の原則（issue #411）:** 新しい検知・検証メカニズムを足すときは、「その起動トリガーは
機械か人か」を先に確認する。人起動（フロー実行の前後でエージェントが手順として実行する形）
なら、それは第3層ルールの削減ではなく追加であり、下記の棚卸し表に行が1つ増えるだけである。
具体的には、hook / CI / cron / npm test のどれに載るかを先に決め、載らないなら新規に作らず
既存の機械ゲートの拡張を探す。2026-07-16のmentor設計レビューで、`npm run eval:workflows`の
手動実行（issue #391）・fault injection訓練の実施（issue #395）・gap check（issue #339）の
実行自体が、いずれも人起動の第3層ルールとして棚卸し表に舞い戻ってきていることが確認された
（検証メカニズムのメタ階層が自己申告→transcript突合→gap check→fault injection/evalの4段まで
増殖し、機械トリガーで自動的に回るのはprompt sync test（npm test内）とSessionStart hookのみ
という実測に基づく）。

## なぜdoc-suggest-check.shをbashのgrep判定からtype: "agent" hookのセッション自己検査型に置き換えたか（issue #418）

`scripts/doc-suggest-check.sh`（Stop hook）は`git diff HEAD`の内容に`facility|tenant|RLS`等の
キーワードが含まれるかのgrep判定で、単語一致だけで発火するため偽陽性が多かった（例:
コメント中に`RLS`という単語があるだけの変更でも発火する）。issue #418で、Claude Codeの
`type: "agent"` hook（Read/Grep/Globを持つサブエージェントが意味レベルで判定する、
experimental機能）への置き換えを検討した。

**実装前に確認した前提（gate check）:** `type: "agent"`が公式ドキュメント
（https://code.claude.com/docs/en/hooks）に実在するかを最初に確認した。複数回の独立した
fetchで一貫して「`type: "agent"`: spawn a subagent that can use tools like Read, Grep, and
Glob to verify conditions before returning a decision. Agent hooks are experimental and may
change.」という記述が確認でき、実在を確認した。

**実装時に発覚した制約と、それが引き起こした設計変更:** agent hookが使えるツールはRead/Grep/
Globのみで、Bash・Writeは使えない（5回の独立したfetchで一貫してこの3ツールのみが挙げられ、
Bash/Writeへの言及は一度もなかった）。このため、旧実装が依存していた以下の2点をそのままagent
hookに移植できないことが判明した:
1. `git diff HEAD`の実行（Bash必須）
2. セッションIDごとのハッシュ状態ファイルへの書き込みによる重複通知抑止（Write必須）

ユーザーと協議の上、「セッション自己検査型」で再設計した。agent hookのプロンプトが、hook入力
JSON（`$ARGUMENTS`）に含まれる`transcript_path`（自セッションのtranscript）をRead/Grepし、
(a) Edit/Write/MultiEditツールで変更されたファイルパスをtool_useブロックから抽出することで
`git diff`の代替とし、(b) 過去に同じ内容のsystemMessageを既にこのセッション内で出力していないか
をtranscript内で文字列検索することで、ハッシュファイルなしにセッション内重複抑止を実現する設計
にした。

もともとのハッシュ抑止も`SESSION_ID`単位（`${SESSION_ID}.hash`、7日で自動掃除）だったため、
実質的にセッションスコープの重複抑止であり、今回の設計変更はこの点で対象範囲を変えていない
（セッションをまたいだ抑止は元々存在しなかった）。

**未検証のまま残っている点（既知の限界）:** agent hookの正確な出力契約（サブアシスタントの
最終応答がどのようにsystemMessage/decisionへ変換されるか）は、ドキュメントの取得が繰り返し
途中で切れたため確定できなかった。プロンプトの末尾で、既存のcommand hookと同一の日本語文言を
返すよう明示的に指示することで、既存の`systemMessage`表示規約に合わせる設計にしている。また、
実際にStop hookとして発火するかどうか・実行時間がtimeout（デフォルト60秒）に収まるかどうかは、
本セッション内では検証不可能（Stop hookは自セッション終了時に発火するため、自分自身の
セッション内から観測できない）。次回以降の実セッションで実際に発火することを人間が確認する
必要がある。
