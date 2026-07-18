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

## なぜ品質ゲートの効果測定をpass/fail集計のみに絞り、blocked実績は対象外にしたか（issue #412）

2026-07-16のmentor設計レビューで、AIDD品質ゲート群（Spec Check / Manifest Check / Adversarial
Verify / Judge Panel等）が「実際に何件の欠陥を止めたか」を示すデータが構造的に存在しないことが
指摘された。効果測定の本格版（issue #394）は集中維持のためnot plannedクローズ済みのため、
`logs/loop-observability.jsonl`の集計のみで済む最小構成として着手した。

**実装前に判明した前提の誤り:** issue #412の起票時点では「ゲートのblocked/fail実績は
loop-observability.jsonlに記録されている」という前提だったが、実装着手時に検証したところ誤り
だった。`scripts/log-loop-observability.sh`の`--result`は`pass|fail`の2値のみを受け付け
（`.claude/agents/reviewer.md`の呼び出し例も`pass`/`fail`のみ）、`blocked`は
`aidd-phase2.js`のAGENT_RESULT_SCHEMAが返す独立した値（Spec Check/Manifest Check/Contract+DB/
Implement/Integrate/Reviewの各ゲート）で、Workflowの戻り値（`stats.blockedAt`等）としてその場に
出るだけであり、リポジトリ内のどのファイルにも永続化されていない。

このため今回のスコープは、loop-observability.jsonlに実在するreviewer/implementer/judge-panelの
pass/fail実績（試行回数・fail率のagent別集計）に絞った。ゲート本体（Spec Check等）のblocked
実績を可視化するには、`aidd-phase2.js`側にblocked判定時のログ永続化を追加する別スコープの作業が
必要であり、今回は着手していない。

**なぜ機械トリガーをGitHub Actions cronではなくStop hookにしたか:** schema-drift-check.yml
（issue #305）と同じ「月次cron + 既存ログの集計」パターンを検討したが、`logs/`は
`.gitignore`で除外されておりリポジトリにコミットされない（ローカル専用ログ）。GitHub Actions
はfresh checkoutで動くためローカルの`logs/loop-observability.jsonl`を参照できず、この方式は
不採用にした。代わりに、セッション終了ごとに必ず発火する既存のStop hook機構
（`scripts/doc-suggest-check.sh`等と同じパターン）を使い、`.claude/.gate-effectiveness-state/
last-summary-at`のmtimeで前回出力から30日経過したかを判定して間引く方式にした。これにより
「起動トリガーは機械」という原則（issue #411のレビューで確認した観点）を保ちながら、GitHub
Secretsやリモートのステータス源を新設せずに済む。

**関連**: #394（クローズ済みの本格版効果測定）、#411（「起動トリガーは機械か人か」の原則）、
#305（同型パターンだが本件では不採用にした理由の比較対象）

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
返すよう明示的に指示することで、既存の`systemMessage`表示規約に合わせる設計にしている。

**訂正（実装直後に判明）:** 実装時点では「Stop hookは自セッション終了時にのみ発火するため
本セッション内では検証不可能」と誤って想定していたが、これは誤りだった。Stopイベントは
「Claudeが応答を終えるたび」に発火する（セッション全体の終了時だけではない）ため、この
`.claude/settings.json`変更をコミットした同一セッション内で、次の応答終了時に実際に
agent hookが発火し、フィードバックとして観測できた。

**実地確認（issue #418実装直後、同一セッション内）:** 「重複通知抑止条件に該当。同じ文言
『domain.md（新しいドメイン用語）とdocs/agents/decisions.md』がセッション内に既に3回存在する
ため、発火しない」という判定結果が実際に返り、以下2点を確認できた:
1. agent hookは実際に発火する（実在確認だけでなく動作確認も取れた）
2. transcript自己検査によるセッション内重複抑止ロジックが機能した

**同時に判明した設計の粗さ:** 上記の3回の一致は、hookが過去に本当にこの文言を
systemMessageとして出力した履歴ではなく、**assistant自身がこのセッション中に説明文・
コミットメッセージ・PR本文で同じ文言を引用したことによる一致**だった。現在のdedup判定は
「transcript中にその文言がどこかに存在するか」しか見ておらず、「hookが過去に本当に発火した
結果として存在するのか」を区別できていない。今回はたまたま正しい結果（抑止すべき状況で
抑止）になったが、一般には、assistant自身の会話文に同じ文言が含まれるだけで、本来初回発火
すべき状況でも誤って抑止されるリスクがある。この区別（hook出力由来かassistant自身の発話
由来か）を厳密につけるには、transcript内のhook出力エントリだけを対象にGrepするような、
より狭い検索パターンへの改善が必要だが、今回はスコープ外として未対応のまま残す。

## issue #399の根本原因確定と修正（Workflowスクリプトのargs文字列化バグ）

issue #399（Spec Checkが指定specPath以外のファイルを読んでpass誤判定する）は、複数回の調査
（PR #402のactualPath自己申告+機械照合追加後も再現）を経て原因不明のまま残っていたが、
2026-07-16の再検証で根本原因を確定できた。

**確定した原因:** `.claude/workflows/aidd-phase2.js`は、`const specPath = args?.specPath ??
'SPEC.md'`のように`args`を直接参照していた。`.claude/workflows/aidd-phase1-router.js`は
既に「Workflowツールに`args`をオブジェクトとして渡してもスクリプト内では`typeof args ===
'string'`（JSON文字列化された状態）で届く」という既知の不具合への防御コード
（`typeof args === 'string' ? JSON.parse(args) : args`、正本は`.claude/workflows/lib/
resolve-workflow-args.js`、issue #413）を持っていたが、`aidd-phase2.js`・`aidd-phase1.js`・
`aidd-1-1-deep-task.js`・`aidd-session-report.js`の4ファイルにはこのガードが**無かった**。
このため`args?.specPath`は常に`undefined`になり、`specPath`は常にデフォルト値`'SPEC.md'`に
フォールバックしていた（`args.specPath`を明示的に無視していたのではなく、単純に読めていな
かった）。

**再検証で得られた実測データ:** 最小構成のWorkflowスクリプト（`args`をログ出力するだけ）を
`args: {"specPath": "..."}`とオブジェクトの形で渡して実行したところ、`typeof args ===
"string"`・`rawArgs`が JSON文字列そのものであることを確認した。この不具合は特定セッション
固有のものではなく、別セッションでも再現する既存の不具合であることが確定した（過去の調査
コメントにあった「別セッション・別環境での再検証を推奨する」という提案への回答）。

**修正:** 上記4ファイルに`aidd-phase1-router.js`と同一の防御コードを追加した。修正後、
`scripts/aidd-fault-injection-setup.sh missing-spec`シナリオを実際に`Workflow`ツールで
実行し、Spec Checkが指定specPath（存在しないパス）を正しくReadしようとして
`blockedAt: "Spec Check"`（`actualPath`は指定した存在しないパスの絶対パス、リポジトリ
ルート直下の無関係な`SPEC.md`ではない）を返すことを確認した。

**副次的に判明した重要な運用上の落とし穴:** `Workflow({name: "aidd-phase2", args: ...})`
（登録済みワークフロー名での起動）は、直前に`.claude/workflows/aidd-phase2.js`を編集して
保存した直後であっても、**古い（編集前の）スクリプト内容で実行された**（生成された
スクリプトファイルの中身を確認して確定）。`Workflow({scriptPath: "<実ファイルの絶対パス>",
args: ...})`で明示的にファイルパスを指定した場合は、正しく編集後の内容が使われた。つまり
`name`指定はキャッシュされたスナップショットを使う可能性があり、ワークフロースクリプトを
編集した直後の動作確認には`scriptPath`で実ファイルを直接指定する必要がある。この挙動の
差異が、過去のissue #399調査で「同じスクリプト内の同じ`specPath`変数のはずなのに
Spec CheckとManifest Checkで挙動が違う」「再検証結果が再現しない」という一見矛盾した観測を
一部説明している可能性がある（過去の調査がどちらの呼び出し方を使ったかは記録が無く確認
できないため、断定はできない）。今後ワークフロースクリプトの挙動を調査・検証する際は、
`name`ではなく`scriptPath`で実ファイルを指定することを推奨する。

## なぜBashサンドボックス機能（issue #438）を導入せず保留にしたか

issue #438は、公式docs調査で見つかったBashサンドボックス機能（OSレベル分離、macOSはSeatbelt
実装）を導入し、無人自律実行の安全基盤（データ流出経路の構造的な遮断）を強化する提案だった。
実装前のゲート条件確認（公式ドキュメントでの仕様実機確認）の過程で、下書き前提との相違が
複数見つかり、最終的に実機検証で「現行toolchainとは非互換」という結論に至った。

**背景の経緯（下書き前提との相違、判明順）:**
1. `sandbox.credentials`（deny/mask）は、セキュリティ設計上プロジェクト側設定
   （`.claude/settings.local.json`含む）では無視され、ユーザー個人の`~/.claude/settings.json`
   でしか効かない。リポジトリにコミット/共有できるのは`filesystem`/`network`設定のみ
2. 下書きが想定していた「まずfallback許容モードで観測開始」という専用モードは公式には
   存在しない。代わりに`allowUnsandboxedCommands`（既定true）がある

**`filesystem.allowWrite`のスコープ設計（実装時点の判断）:** サンドボックスの目的が書き込み
制限である以上、`$HOME/**`のような広い許可は制約を骨抜きにする。本プロジェクトのCLAUDE.md
運用が実際にcwd外（`$HOME`配下）への書き込みを要求する箇所を`write_aidd_stats.sh`/
`aidd_session_report.sh`の実装を読んで洗い出し、`~/.claude/aidd-session-stats/`（書き込み
先ディレクトリ）と`~/.claude/pending_issues.jsonl`（issue自動作成用の単一ファイル）の2パスに
個別列挙で絞った。この設計自体は妥当だったが、後述の通りそもそもsandbox自体が導入不能と
判明したため未使用のまま終わっている。

**実機検証で確定した非互換性:** 隔離ディレクトリ（本体リポジトリとは別）でheadlessセッション
（`claude -p`）を用い、`sandbox.enabled: true`の複数パターンでgh/supabase CLIの動作を検証した。

| 設定パターン | 認証方式 | 結果 |
|---|---|---|
| network.allowedDomains設定あり | keychain(通常) | `gh`がTLS証明書検証エラーで失敗（`x509: OSStatus -26276`） |
| filesystem.allowWriteのみ（network設定なし） | keychain(通常) | `gh auth status`がkeychainアクセスエラーで失敗（2回再現） |
| filesystem.allowWriteのみ（network設定なし、確認済み） | GH_TOKEN環境変数（keychain回避） | `gh issue list`がTLS証明書検証エラーで失敗（`x509: OSStatus -26276`） |
| 同上 | SUPABASE_ACCESS_TOKEN環境変数（keychain回避） | `supabase projects list`が同一のTLS証明書検証エラーで失敗（`x509: OSStatus -26276`） |
| サンドボックス無効（対照実験） | 通常 | `gh issue list`成功（終了コード0） |

**結論:** `network.allowedDomains`の設定有無に関わらず、`sandbox.enabled: true`にした時点で
Bashの通信がTLS中継の対象になる。keychain認証を環境変数トークンで迂回してもTLS層で同じ
エラーが再発することから、keychainアクセスの問題とTLS中継の問題は別々に存在し、片方を回避
してももう片方で壊れる、という二重の壁だった。gh・supabase CLIの両方で同一エラーが再現して
おり、Go製CLI全般に共通する非互換性である可能性が高い（curlは同様の状況で成功しており、
影響を受けるのはGoの`crypto/tls`がサンドボックスのTLS中継プロキシ証明書を信頼しないケースに
限られると考えられる）。

このリポジトリの開発フローはgh（issue/PR管理）・supabase CLI（migration/DB操作）の両方に
強く依存しており、`sandbox.enabled: true`を有効化すると開発が成立しない。upstream側でTLS
中継プロキシの証明書をGoバイナリが信頼できるようにする対応（またはサンドボックス側に除外
設定）が提供されるまで、issue #438は保留とする。

**再開条件:** Claude Code側のリリースノートでsandbox×Go製CLIの既知問題に対応が入った場合、
またはTLS中継を回避しつつ書き込み制限のみ有効化する設定が新たに追加された場合。

## なぜworkflow()によるPhase1→Phase2の自動連結を導入しなかったか（issue #442）

issue #442は、Workflow DSLの未使用機能の1つとして「`workflow()`ネストによるphase1→phase2の
連結を親workflowから一元制御できるか検討する」ことを挙げていた。調査の結果、**導入しない**
と判断した。

**調査で分かったこと:**
1. `aidd-phase1-router.js`は既に`workflow('aidd-1-1-deep-task', ...)` /
   `workflow('aidd-phase1', ...)`という形で`workflow()`ネストを使っている（72-73行目）。
   ただしこれはPhase 1**内部**でのルーティング（軽量Sweep vs 深掘り調査のどちらを起動するか）
   であり、issue #442が意図していた「Phase 1 → Phase 2」という**フェーズをまたぐ**連結とは
   別物である。
2. `aidd-phase2.js`は「呼び出し前に人間が確認すること」として「停止①（人間承認）が完了して
   いること」を前提条件に明記している。ルートの`CLAUDE.md`の絶対ルールでも「停止①：仕様書を
   提示したら、人間が承認するまで Phase 3（実装）へ進まないこと」と定めている。
3. Workflowツールには、人間の承認・入力を待って処理を一時停止するプリミティブが存在しない
   （`agent()`はすべて自動実行され、途中で人間の応答を待つ手段が無い）。

**結論:** もしPhase 1（`aidd-1-1-deep-task.js`）の末尾で`workflow('aidd-phase2', ...)`を
自動的に呼ぶ設計にすると、人間がSPEC.mdを承認する前にPhase 3の実装が自動的に始まってしまい、
停止①の絶対ルールに構造的に違反する。Workflow DSLが「人間の承認待ち」を表現する手段を
持たない以上、この連結は安全に実装できない。加えて`workflow()`のネストは1階層までという
制約もあり（`workflow()`の中でさらに`workflow()`を呼ぶとエラーになる）、
`aidd-phase1-router.js`経由で既に1階層使っている経路からは、技術的にもPhase 2への
再ネストは不可能である。

**現状維持とする運用:** Phase 1完了後、人間がSPEC.mdの内容を確認・承認してから、
Claude（オーケストレーター）が改めて`Workflow({ name: "aidd-phase2", ... })`を呼び出す
という現行フローを変更しない。「一元制御」という言葉が示唆する自動化は、停止①という
安全装置とは原理的に両立しないため、Workflow DSL側の制約緩和（人間承認待ちプリミティブの
追加等）が将来提供されない限り再検討しない。

## なぜissue #444のPreToolUse hookを警告のみ/denyの二段構えにしたか

issue #444（issue #339の優先度2候補2件の機械化）で、2本のPreToolUse hookを実装した。

**① `scripts/check-run-manifest-presence.sh`（Write/Edit/MultiEdit、警告のみ）:**
TRI/RISK基準に該当する高リスクパスへの書き込み時に`.aidd/run-manifest.json`が無ければ、
`aidd-phase1-router`を経由せず直接実装に入った可能性を警告する。**ブロックしない**理由は、
Phase 1調査の初期段階（run-manifest.jsonがまだ書き出されていない正当なタイミング）や、
AIDDフローを使わない軽微な修正でも高リスクパスに触れることが普通にあり、これらを毎回denyや
askで止めると開発体験を大きく損なうため。まずは`additionalContext`でモデルに気づかせる
observeファーストの設計とした（issue #438の教訓とは別に、[OTel](#opentelemetryと自作jsonlの役割分担issue-417)・
[baseline snapshot](#agents設定変更時のbaselineスナップショット機械強制issue-429)等と同じ
「まず観測から」という一貫した方針）。

v1スコープは**存在チェックのみ**とし、issue原案にあった「鮮度」（baseCommitと現在のHEADの
乖離検知等）は見送った。長時間の実装セッションでは正当な理由でHEADが進むことが多く、
鮮度判定を入れると誤検知率が上がるリスクの方が高いと判断した。

**② `scripts/check-direct-ddl-execution.sh`（Bash + MCP、deny）:**
`supabase db execute`・`psql`直接実行によるmigrationファイルを経由しないDDL適用を無条件で
denyする。①と異なりwarningではなくdenyにした理由は、common.mdの既存ルール
「execute_sql等による直接実行・直接DDL適用は禁止（ローカル・リモート問わず）」が既に
例外なき禁止として明文化されており、「まず観測」の余地がない（正当なユースケースが
存在しない）ため。`supabase db push`/`db reset`等はmigration適用の正規手段そのものであり
対象外とした（denyすると正しいワークフローを壊す）。SQL内容の解析（DDL文かどうかの判定）は
せず、コマンド/ツール自体を丸ごとdenyする設計とした（内容ベースの判定は誤検知・すり抜け
双方のリスクが高く、`scripts/check-skip-marker-write.sh`と同じ設計方針）。

**実装レビュー時に見つかったスコープの穴（MCPツール経由の抜け道）:** 当初の設計は
`matcher: "Bash"`のみで、`supabase db execute`/`psql`のBash実行だけを対象にしていた。
レビューで「Supabase MCPサーバーの`execute_sql`ツールを直接呼び出せば、このガードレールを
素通りする」という指摘を受けた。確認したところ、このリポジトリの`.mcp.json`には現時点で
Supabase MCPサーバーは定義されておらず、今すぐ悪用可能な状態ではなかったが、個人設定や
将来の追加でMCPサーバーが有効化された場合に備え、matcherを`"Bash|mcp__.*execute_sql"`
（サーバー名を固定しない正規表現）に拡張し、スクリプト側もcase文で両方を扱うようにした。
common.mdの既存文言「execute_sql等」という書き方自体が、この種のMCPツールを念頭に置いた
表現だったと考えられる。

**実装中に実機で発見した2件のバグ（テスト作成時に自己適用して判明）:**
1. `check-run-manifest-presence.sh`の初期実装は、`tool_input.file_path`が絶対パスの場合に
   そのままドメインキーワード（`inventory`等）と正規表現照合していた。このリポジトリ自身が
   「medical-inventory-vkumai」という名前のため、**リポジトリ内外を問わずあらゆる書き込みで
   常に誤検知する**バグだった。実際にこのhookを自分自身で動かした際、スクラッチディレクトリ
   （リポジトリ外）への無関係なファイル書き込みで発火し、その場で発覚した。修正として、
   `tool_input.file_path`を必ずリポジトリルートからの相対パスに正規化してから照合するように
   変更した。単純な文字列prefix比較では不十分で、macOSの`/var` → `/private/var`シンボリック
   リンクにより`git rev-parse --show-toplevel`（正規化済みパスを返す）と`tool_input.file_path`
   （非正規化パスのことがある）が文字列として一致しないケースがテスト作成時に発覚したため、
   `python3`の`os.path.realpath`で両者を同じ基準に正規化してから`os.path.relpath`で相対パスを
   求める方式にした。
2. `check-direct-ddl-execution.sh`の初期実装は、コマンド境界の表現に`\b`（単語境界）を
   使っていたが、bashの`[[ =~ ]]`（POSIX ERE相当）は`\b`を単語境界として解釈せず、
   パターンごと静かにマッチしなくなっていた（`supabase db execute`が検知されないという
   形でテスト失敗として顕在化）。`[[:space:]]|$`を使った明示的な境界表現に置き換えて修正した。

いずれも「テストを書いて実際に動かす」ことで発見できたバグであり、レビューコメントの指摘
（MCPツールの抜け道）とは独立に、実装者自身のセルフテストで見つかった。issue #438の
「実装前に実機確認する」という教訓の延長で、「実装後もテストで実機確認する」ことの価値を
改めて示す事例になった。

## なぜautoMode(hard_deny)を個人設定のみにし、SessionStart hookで設定し忘れを検知することにしたか（issue #439）

issue #439は当初「autoMode設定(hard_deny)で医療データ外部送信・RLS無効化を無条件ブロックする」
という機能導入提案だったが、ゲート条件確認（公式ドキュメント実機確認）の結果、issue #438の
`sandbox.credentials`と同型の制約が判明し、方針を変更した。

**確認した事実（推測ではなく公式ドキュメントの原文で確認済み）:** `autoMode`のclassifierは
`.claude/settings.json`・`.claude/settings.local.json`（どちらもリポジトリのディレクトリ内に
存在するファイル）から`autoMode`設定を読まない。
出典: https://code.claude.com/docs/en/auto-mode-config.md 「Where the classifier reads
configuration」セクション。理由も明記されている: "a checked-in repo or a build step could
otherwise inject its own allow rules"（コミットされたリポジトリやビルドステップが、独自の
許可ルールを勝手に注入できてしまうため）。`.claude/settings.local.json`を対象外にしている
理由も同様（"Excluding .claude/settings.local.json also closes the case where a repository
commits the file or a local tool or build step writes it."）。

この事実確認自体、当初は調査エージェントの要約を鵜呑みにしそうになったが、「その理由は
本当にドキュメントに書かれているのか、それとも推測か」という指摘を受けて出典URLと原文引用を
再確認する一手間を挟んだ。issue #438の「実装前に実機確認する」を、「実機確認の結果自体も
一次情報で裏取りする」までもう一段踏み込んだ形。

**判明した仕様（下書き想定と一致した部分）:** キー名（`environment`/`hard_deny`/`soft_deny`/
`allow`）・評価順序（`hard_deny → soft_deny → allow → 明示的なユーザー意図`、`permissions.deny`
より後に評価される追加の層）は下書きどおりだった。

**判明した既知の限界（下書きに無かった情報）:** 各classifier呼び出しはトークンコストが
増加する。また3回連続/20回総ブロックで自動fallbackする仕様があり、「ユーザー意図でも
上書き不可の無条件ブロック」という説明どおりには機能しきらない可能性がある（一定数
ブロックが続くと効かなくなる）。

**結論・設計判断:** `autoMode`はプロジェクト側にコミットして全員へ強制する形では実装
できない。issue #438のcredentials設定と同じ構造的制約であり、[「Bashサンドボックス機能は
現行toolchainと非互換のため保留」](#なぜbashサンドボックス機能issue-438を導入せず保留にしたか)
と同種の判断が必要になった。ただし#438（toolchain非互換で使用そのものが不可能）とは異なり、
#439は「使うこと自体は個人設定で可能・プロジェクト側からは強制できないだけ」という違いが
あるため、保留にはせず「推奨設定をdocs/agents/common.mdに文書化し、各自の
`~/.claude/settings.json`への追加を促す」個人オプトイン方式で実装した。

**「書いただけでは気づかれない」への追加対応:** ドキュメント化のみで終えると、issue #423
（loop-observability記録漏れ、自然言語指示への依存が実際に5日分の記録欠落を招いた事例）と
同型の弱さが残るという指摘を受け、`scripts/check-automode-config.sh`（SessionStart hook）を
追加した。個人設定に`autoMode.hard_deny`が存在しなければセッション開始時に警告する
（block不可・warningのみ、`check-otel-collector-status.sh`と同じパターン）。ただし
`hard_deny`の**内容**（実際に医療データ外部送信・RLS無効化を正しくカバーしているか）までは
検証しない。存在チェックに留めた理由は、`environment`/`hard_deny`が自然言語記述であり、
内容の妥当性を機械的に判定する信頼できる方法が無いため（issue #438のcredentials同様、
platform側の内部メカニズムが完全には文書化されていない）。

## なぜchangedFiles提供時はtaskDescriptionのキーワード判定を無効化したか（issue #456）

issue #286で`aidd-phase1-router.js`のTRI/RISK判定は「ファイルパス一致を優先し、キーワード
一致は補助判定として残す（どちらか一方でも該当すれば深掘りへ）」という設計にしていた。
issue #442の調査で、この設計が実際にコストの大きい誤判定を引き起こすことが判明した。

**発生した実害:** taskDescriptionに「DB/RLS/auth/facility等のドメインには触れない」という
**否定文**を書いたところ、`matchedPaths: []`（変更対象ファイルは実際に高リスクパスに一切
該当しないと正しく判定済み）だったにもかかわらず、"auth"・"facility"・"rls"という単語が
単純一致し、`matchedKeywords`経由で高リスクと誤判定された。結果、無関係なドメインの
深掘り調査（83エージェント・約504万トークン・42分）が無駄に実行された。

**検討した代替案と却下理由:** 「触れない」「不要」「関係ない」等の否定語を検出する自然言語的な
ヒューリスティックも検討したが、日本語の否定表現は「〜には触れるが、〜には触れない」のような
複合文を含め表現パターンが多様で、キーワードとの近接性判定を正確に作り込むのは実装コストが
高く、かつ新たな誤判定（否定の見落とし・過検知）を生みやすいと判断し見送った。

**採用した設計:** `changedFiles`が1件以上渡されている場合は`matchedPaths`（パスベース判定）
のみで`isHighRisk`を決め、`matchedKeywords`は判定に使わない（補助情報としてログ・戻り値には
引き続き含める）。実際に変更するファイルが分かっている場合は、taskDescriptionの文言よりも
そちらの方が確度が高いという判断による。`changedFiles`が空（未指定含む）の場合のみ、
後方互換としてキーワード一致で判定する（issue #286時点の挙動を維持）。

この変更により、`changedFiles`を正しく渡す呼び出し（router.jsの想定利用法どおり）では
否定文脈による誤判定が起きなくなる一方、`changedFiles`を渡さない古い呼び出し方や、
そもそも変更対象ファイルが未確定な設計初期段階の呼び出しでは、引き続きキーワード一致に
頼った判定になる（common.mdのTRI/RISK原則「迷ったら高リスク側」を維持）。
