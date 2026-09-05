# 設計判断の記録: AIDDパイプライン

[`../decisions.md`](../decisions.md) からの分野別分割（issue #491）。Workflow DSL・TRI/RISKルーター・品質ゲート・hookに関する「なぜその設計にしたか」の記録。各エントリ冒頭の太字1行が結論、以下が背景・理由。

## なぜTRI/RISK判定を機械判定にし、人の裁量で緩めないことにしたか

**結論: 高リスクパス・ドメインに触れる変更はレビュー省略可否を人間の裁量に委ねず、無条件でM/L扱いにする。**

`supabase/migrations/` ・`src/lib/supabase/` ・`middleware.ts`/`proxy.ts` ・auth/facility/tenant/
organization/inventory/RLS/policyドメインに触れる変更は、無条件でM/L扱い（RISK=はい）と
common.mdに定めている。

これらは施設間データ越境・権限昇格など、事故った際の被害が大きく後戻りしにくい領域。
「今回は軽微だから」という都度の判断を許すと、判断者によって基準がぶれて事故を防げなくなる
ため、レビュー省略可否の裁量を人間に与えない設計にした。

## なぜaidd-phase1-router.jsでargsをJSON.parseする防御コードを入れたか

**結論: Workflowツール自体がargsをJSON文字列化して渡す未解決の不具合への防御として、`typeof === 'string'`ガードを入れる。**

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

## なぜ品質ゲートの効果測定をpass/fail集計のみに絞り、blocked実績は対象外にしたか（issue #412）

**結論: blocked実績はどこにも永続化されていないと判明したため、loop-observability.jsonlに実在するpass/fail実績のみに測定スコープを絞った。**

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
（`scripts/verify-claims.sh`等と同じパターン）を使い、`.claude/.gate-effectiveness-state/
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

**結論: grepベースの単語一致(偽陽性が多い)を、transcript自己検査によるセッション内自己検査型のagent hookに置き換えた。**

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

**結論: `aidd-phase1-router.js`以外の4つのワークフローファイルにargs文字列化への防御コードが無かったことが根本原因。全ファイルに同一の防御を追加して解消した。**

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

修正後、`scripts/aidd-fault-injection-setup.sh missing-spec`シナリオを実際に`Workflow`ツールで
実行し、Spec Checkが指定specPath（存在しないパス）を正しくReadしようとして
`blockedAt: "Spec Check"`（`actualPath`は指定した存在しないパスの絶対パス、リポジトリ
ルート直下の無関係な`SPEC.md`ではない）を返すことを確認した。

Workflowスクリプトの動作確認時の運用上の注意（`name`指定は編集直後の内容を反映しない可能性があり、`scriptPath`で実ファイルを指定すべきという実測ベースの教訓）は、[`known-failure-patterns.md`](../known-failure-patterns.md#ワークフロースクリプトをnameで起動すると編集直後の変更が反映されないことがある)の汎用チェック項目として移設した。

## なぜBashサンドボックス機能（issue #438）を導入せず保留にしたか

**この決定の全文は[`tooling-decisions.md`](../tooling-decisions.md#bashサンドボックス機能は現行toolchainと非互換のため保留issue-438)に統合した（issue #491でtool-adoption系の決定を集約）。**

## なぜworkflow()によるPhase1→Phase2の自動連結を導入しなかったか（issue #442）

**結論: Workflow DSLには人間の承認待ちを表現する手段が無いため、Phase1→Phase2を自動連結すると停止①の絶対ルールに構造的に違反する。よって導入しない。**

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

**結論の詳細:** もしPhase 1（`aidd-1-1-deep-task.js`）の末尾で`workflow('aidd-phase2', ...)`を
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

**結論: run-manifest.json存在チェックは正当な例外が多いため警告のみ、DDL直接実行は既に例外なき禁止が明文化済みのためdenyにする。**

issue #444（issue #339の優先度2候補2件の機械化）で、2本のPreToolUse hookを実装した。

**① `scripts/check-run-manifest-presence.sh`（Write/Edit/MultiEdit、警告のみ）:**
TRI/RISK基準に該当する高リスクパスへの書き込み時に`.aidd/run-manifest.json`が無ければ、
`aidd-phase1-router`を経由せず直接実装に入った可能性を警告する。**ブロックしない**理由は、
Phase 1調査の初期段階（run-manifest.jsonがまだ書き出されていない正当なタイミング）や、
AIDDフローを使わない軽微な修正でも高リスクパスに触れることが普通にあり、これらを毎回denyや
askで止めると開発体験を大きく損なうため。まずは`additionalContext`でモデルに気づかせる
observeファーストの設計とした（issue #438の教訓とは別に、OTel・baseline snapshot等と同じ
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

実装中に実機で発見した2件のバグ（`tool_input.file_path`のパス正規化漏れによる自己参照的な誤検知、bashの`[[ =~ ]]`が`\b`単語境界を解釈しない問題）は、[`known-failure-patterns.md`](../known-failure-patterns.md#hookスクリプトのパス正規化漏れとbashの単語境界表現の落とし穴)の汎用チェック項目として移設した。いずれも「テストを書いて実際に動かす」ことで発見できたバグであり、issue #438の「実装前に実機確認する」という教訓の延長で、「実装後もテストで実機確認する」ことの価値を改めて示す事例になった。

## なぜautoMode(hard_deny)を個人設定のみにし、SessionStart hookで設定し忘れを検知することにしたか（issue #439）

**この決定の全文は[`tooling-decisions.md`](../tooling-decisions.md#automodehard_denyは個人設定のみ有効設定し忘れ検知はsessionstart-hookでissue-439)に統合した（issue #491でtool-adoption系の決定を集約）。**

## なぜchangedFiles提供時はtaskDescriptionのキーワード判定を無効化したか（issue #456）

**結論: `changedFiles`が1件以上ある場合はパスベース判定のみでリスクを決め、キーワード一致は判定に使わない。**

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

## なぜchangedFiles空時のキーワード一致フォールバックを人間確認に変えたか（issue #500）

**結論: `changedFiles`が空の場合のキーワードのみ一致は、深掘りルートへ自動突入せず新設した`confirm`ルート（エージェント0台・人間確認を挟む）へ振り分けるよう変更した。**

issue #456の対応（上記）は「`changedFiles`が空の場合のみ、後方互換としてキーワード一致で
判定する」という設計を意図的に残した。しかし2026-07-21、issue #483（6-pairフレームワーク
検証2本目）のPhase1着手時、taskDescriptionに「DBスキーマ変更・facility/tenant/auth境界には
触れない想定」という否定文を含めて`changedFiles: []`（実装前の調査段階なので当然ファイルは
未確定）で呼び出したところ、まさにこのフォールバック経路を踏み、"スキーマ"・"auth"・
"facility"・"tenant"が単純一致してdeepルート（`aidd-1-1-deep-task`）に誤って振り分けられた。
結果、77エージェント・約346万トークン・約29分という規模のコストが発生した。

**重要な事実:** `changedFiles`が空になるのは異常系ではなく、`aidd-phase1-router.js`の
**主要な使われ方そのもの**である。Phase1調査は「まだ何も実装していない段階」で呼ばれるため、
変更予定ファイルが未確定なのは通常運転。つまりissue #456で「後方互換のため」残した
フォールバック経路は、実際には最も頻繁に通る経路であり、修正したはずの症状が確実に
再発し続ける設計になっていた（issue #456で発生した「83エージェント・約504万トークン・42分」の事例と同型の誤判定が、規模を変えて再発した形）。

**検討した代替案と却下理由:**
- 否定表現（「触れない」「不要」「関係ない」等）を検出する自然言語ヒューリスティックの追加。
  issue #456時点と同じ理由（日本語の否定表現は複合文を含め表現パターンが多様で、実装コストが
  高くかつ新たな誤判定を生みやすい）で見送った。実害の規模が変わっても、この構造的な難しさ
  自体は変わらない。
- `changedFiles`が空の場合はSレーン相当の軽量Sweep（`aidd-phase1`）を先に実行し、Sweep結果から
  実際に触れるファイルが判明した時点で`classifyRisk`をパスベースで再評価する二段階方式。
  ルーターの「まず判定→それから実行」というモデルを崩す設計変更になり、実装・テストの複雑さが
  増す。軽量Sweep自体もエージェントを何台か立てるため、コストがゼロになるわけでもない。

**採用した設計:** `changedFiles`が空（未指定含む）で`taskDescription`のキーワードのみが
一致した場合、`classifyRoute`は`deep`ルートへ自動的に振り分けず、新設した`confirm`ルートを
返す。`aidd-phase1-router.js`はこのルートに対して`workflow()`を一切呼ばず（＝エージェントを
1台も起動せず）、判定保留の理由と推奨アクションを含む結果を返して終了する。呼び出し側
（Claude Code本体）はこの結果を見て、人間に実際に高リスクドメインへ触れる変更かどうかを
確認してから、`aidd-1-1-deep-task`または`aidd-phase1`を明示的に呼び出す。

判定ロジック自体（`isHighRisk`の計算方法）は変更していない。「迷ったら高リスク側に倒す」
というcommon.mdのTRI/RISK原則も、`isHighRisk: true`という情報自体は保持されたまま
`confirm`ルートとして返るため崩れていない。変わるのは「無人で自動的に深掘り調査へ突入する」
から「人間の確認を挟んでから深掘り調査に進む」への一点のみであり、既にコストの大きさが
実測されている以上、この一手間は妥当なコストと判断した。

`changedFiles`が1件以上ある場合（パスベース判定が効く場合）はこの`confirm`分岐を通らず、
issue #456で修正した「`matchedPaths`のみで`isHighRisk`を決める」挙動がそのまま適用される
（この経路は変更していない）。

## なぜメタ改修判定をキーワードマッチより先に評価することにしたか（issue #457）

**結論: `.claude/workflows/`・`.claude/agents/`・`docs/agents/`配下のみの変更は、TRI/RISK判定より先に「メタ改修」と確定させ、4軸Sweepを一切実行しない専用ルートへ振り分ける。**

`aidd-phase1-router.js`のTRI/RISK判定は「プロダクトコード変更」を前提に設計されており、
「パイプライン自体のメタ改修」（`.claude/workflows/`・`.claude/agents/`・`docs/agents/`配下の
変更）という第5のカテゴリが無かった。issue #456と同一の実測事例（83エージェント・約504万
トークン・42分の無駄なコスト。詳細は本ファイル「なぜchangedFiles提供時はtaskDescriptionの
キーワード判定を無効化したか（issue #456）」を参照）を受けて設計を見直した。issue #457着手
時点では未マージだったが、実装中に並行してissue #456が同じ実測事例を根拠に`classifyRisk`
自体を修正するPRを先にマージしたため、両者の関係を整理する必要が生じた（後述）。

**判断1: メタ改修判定を`classifyRisk`呼び出しより「先に」評価する。** 当初はこの優先順位
自体が症状1（否定文脈のキーワード誤検知）への対策と位置づけていたが、issue #456が
`classifyRisk`側で`changedFiles`提供時はキーワード一致を一切使わない設計に修正したため、
症状1は`classifyRisk`単体で既に解消されている（`.claude/workflows/`配下のみの変更であれば
`matchedPaths`は必然的に空になり、`isHighRisk`はfalseになる）。したがって「メタ改修判定を
先に評価する」ことの実質的な意味は**症状2（無駄な4軸Sweep実行）の回避に一本化**された。
メタ改修判定を`classifyRisk`より先に置く設計自体は残す（`classifyRisk`を呼ぶまでもなく
即座にmetaルートへ確定でき、無駄な計算を避けられるため）が、症状1対策としての位置づけは
issue #456のマージ後に後退した、という経緯を記録しておく。

**判断2: メタ改修判定の発火条件を「changedFilesが1件以上あり、かつ全件がメタ改修パス配下」
という厳格な条件にした。** 1件でもプロダクトコード（例: `src/app/`配下）が混在する場合や、
changedFiles自体が指定されていない場合は、メタ改修判定を一切発火させず既存のTRI/RISK判定
（プロダクトコード向け）にそのまま委ねる。これにより「既存の高リスクパス判定は一切緩めない」
という制約（依頼元の指示）を、優先順位の設計だけで機械的に満たせる。メタ改修判定の対象範囲
（`.claude/workflows/`・`.claude/agents/`・`docs/agents/`の3つのみ）を意図的に狭く保ったのも
同じ理由で、対象を広げるほど「本当はプロダクトコードに影響するのにメタ改修と誤判定される」
リスクが増えるため、安全側に倒した。

**判断3: メタ改修ルートでは、深掘り調査だけでなく軽量Sweep（`aidd-phase1`）も呼ばず、
`workflow()`を一切呼ばずに直接結果を返す設計にした。** issueは「4軸Sweepにツール層向けの
軸を追加する」か「Sweep自体をスキップする」かの判断を委ねていた。前者（軸追加）は
`sweep-ui`/`sweep-data`等の既存4エージェント・プロンプトを変更する必要があり、プロダクト
コード向けのSweep体系に例外分岐を持ち込むことになる。後者（スキップ）は症状2（無駄な
3軸実行）を実行コストゼロで解消でき、実装もルーター内で完結する。過剰実装を避ける観点から
後者を選んだ。将来「メタ改修タスクにも軽量な自動チェックが欲しい」となった場合は、
専用の新しいSweep軸（例: `sweep-pipeline-consistency`）を別issueとして追加する方が、
既存4軸の意味を汚さずに済むと判断した。

**判断4: `.claude/workflows/lib/router-risk.js`（正本）と`aidd-phase1-router.js`
（Workflow DSLインライン複製）のペアには、これまでバイト単位の同期テストが存在しなかった
（`workflow-prompt-sync.test.js`等の既存パターンはテンプレートリテラル＝プロンプト文字列の
同期用で、`const`配列・`function`宣言の同期には使えなかった）。今回の変更で複製対象のロジックが
増える（3方向ルーティングの判定関数が追加される）ため、`extract-declaration.js`という新しい
抽出ユーティリティ（`export `プレフィックスの有無を正規化しつつ、`{}`/`[]`の対応する閉じ括弧
まで宣言本体を抽出する）を追加し、`router-risk-sync.test.js`で両ファイルの宣言が一字一句
一致することを機械検証するようにした。「ロジックが薄いうちは複製の同期テストを省略しても
実害が小さい」という従来の暗黙の判断（issue #457着手前の状態）を、ロジックが複雑化した
タイミングで機械検証に切り替えた形。

## なぜblockedラベルの再開条件見直しをcronではなくSessionStart hookのポーリングにしたか（issue #453）

**この決定の全文は[`tooling-decisions.md`](../tooling-decisions.md#blockedラベルの再開条件見直しはsessionstart-hookで機械ポーリングissue-453)に統合した（issue #491でtool-adoption系の決定を集約）。**

## なぜChannels(issue #448)を導入せず見送ったか

**この決定の全文は[`tooling-decisions.md`](../tooling-decisions.md#channelsissue-448は今回のユースケース夜間ジョブ通知に不向きなため見送り)に統合した（issue #491でtool-adoption系の決定を集約）。**

## なぜclaude-code-action(issue #447)を導入せず見送ったか

**この決定の全文は[`tooling-decisions.md`](../tooling-decisions.md#claude-code-actionissue-447は費用対効果の観点で見送り)に統合した（issue #491でtool-adoption系の決定を集約）。**

## なぜissue #443の夜間バッチ構想をSessionStart hookに縮小したか

**この決定の全文は[`tooling-decisions.md`](../tooling-decisions.md#定期実行の機械トリガー化はsessionstart-hookに一本化os-launchdは見送りissue-443)に統合した（issue #491でtool-adoption系の決定を集約）。**

## issue #441（/goalサーキットブレーカーの機械化）の実機確認結果と対応範囲

**結論: `/goal`は時間ベース上限を直接サポートせずターン数埋め込みのみ、かつ設定有無を外部から機械検知する手段は無いと確認した。条件テンプレート化・役割分担の明文化のみ実施し、検知不能自体は棚卸し表に残した。**

issue #441は「CLAUDE.mdのサーキットブレーカー運用（`/goal`設定・テスト修正3回まで・フロー
全体上限）は自然言語ルールのままで、検知手段のないルールの棚卸し（issue #339）の第3層に
載ったまま」という課題認識から、`/goal`機能の条件構文・評価タイミング・検知可否をゲート
条件として公式ドキュメントで確認した。

**確認できた事実:**
- `/goal`は実在する公式機能（セッションスコープの自動ループ機能）
- 条件構文は達成条件（自然文）のみで、ターン数上限は`or stop after 20 turns`のように条件文に
  埋め込む形でサポートされる。**時間ベースの上限（M時間経過）は直接サポートされていない**
  （下書きの想定と異なる。CLAUDE.md「サーキットブレーカー」節と`docs/agents/observability-internals.md`
  「statuslineでcontext・コスト・レート制限を可視化（issue #446）」節の両方に「ターン/時間
  上限」という誤った記述が残っていたため、本issueで両方訂正した）
- 評価は毎ターン終了後にLLM（既定Haiku）が会話内容のみで判定する（ツール呼び出しは行わない）。
  決定論的な機械判定ではない
- **「`/goal`が設定されているか」を外部から機械的に検知する公式なAPI/hookは存在しない**
  （実機確認済み）。issue本文が用意していた「検知できないなら棚卸し表に明記する」という
  エスケープハッチの条件に該当したため、このルール自体は棚卸し表（issue #339）に残した
- サブエージェント（Agent tool/Workflowの`agent()`呼び出し経由の別セッション）への適用可否は
  ドキュメントに明記が無く未検証のまま残っている

**対応した範囲:**
1. `/goal`条件テンプレートをCLAUDE.md「サーキットブレーカー」節に明記（ターン数埋め込み形式、
   時間ベース上限は使えないことも明記）
2. 「テスト修正3回まで」と「フロー全体の上限」の役割分担を明文化: Workflow内部のretryループ
   （review-implementer retry最大3回等）は既にコードで強制済みで、`/goal`が担うのはWorkflow
   **外**（このセッション自身が手動でターンを重ねる修正・再試行ループ）の上限という、
   別レイヤーの防御であることをCLAUDE.mdに追記した
3. 検知不能という結論自体を棚卸し表の該当行に追記し、今後の検討で「issue #441は解決済みなのに
   なぜまだ棚卸し表に載っているのか」と誤解されないようにした

## なぜ/goalターン数上限の例示値を20→15に再校正したか（issue #498）

**結論: セッション transcript の実測データ（claude-fable-5、n=231、2026-07-03〜07-08の6日間）から、旧世代モデル比で1ターンあたり平均出力トークン数が約1.3倍と分かったため、CLAUDE.md「サーキットブレーカー」節の例示値を20ターン→15ターンへ安全側（上限を厳しくする方向）に更新した。**

CLAUDE.mdのサーキットブレーカー節の例示値（「20ターン経過で停止」等）は、Fable 5登場前の
旧世代モデルの1ターンあたり作業量を前提にしていた。Fable 5は公式ガイドで「デフォルトで
より長いターン」になりうるとされており、1ターンが意味する作業量・コストが変わるなら、
同じターン数を上限にしても財布を守る効果が実質的に薄まる。

**実測結果:**
- `~/.claude/projects/-Users-masanori-medical-inventory-vkumai/*.jsonl`（このプロジェクトの
  全セッションtranscript）を対象に、`type: "assistant"`エントリを`message.model`でグループ化して集計した
- `claude-fable-5`: 231件、平均出力トークン/ターン 約817（2026-07-03〜07-08）
- `claude-sonnet-4-6`（旧世代・比較対象）: 2,926件、平均出力トークン/ターン 約617（2026-06-24〜07-01）
- 比率は約1.3倍。「桁で変わる」という当初の想定ほど劇的な差ではなかった

**限界（明記の上で採用）:**
- 集計は「assistant APIコール1件」を1ターンとして数えており、`/goal`が実際に評価する
  「1回のユーザー発言に対する一連のtool-use往復すべて」という粒度とは一致しない可能性がある
- Fable 5のサンプルは231件・6日間のみで、n数・期間ともに小さく、季節性・曜日効果・
  タスク内容の偏りは排除できていない
- トークン数は作業量の代理指標であり、実際の壁時計時間（1ターンが数分〜数時間になりうる点）
  は今回測定していない

**採用した理由:** この変更はサーキットブレーカーを緩める方向ではなく厳しくする方向（20→15）
であり、迷ったら安全側に倒すという本プロジェクトのTRI/RISK判定と同じ哲学に沿う。加えて
「検知手段のないルールの棚卸し」（issue #339）が警告する「先送りにして忘れられるルール」の
再発を避けるため、n数が小さいことを理由に数値確定を保留せず、限界を明記した上でここに記録し、
モデル世代が変わるたびに見直す前提を残した。

## なぜsecurity-guidanceプラグイン（issue #440）をチーム共有で全層有効化したか

**この決定の全文は[`tooling-decisions.md`](../tooling-decisions.md#security-guidanceプラグインでknown-failure-patternsmdを機械検知化issue-440)に統合した（issue #491でtool-adoption系の決定を集約）。**

## issue #494（ワークフロー内ハードコードのモデルID陳腐化対策）の棚卸し・実機確認結果

**結論: `aidd-1-1-deep-task.js`の7箇所のフルIDをティア名エイリアス(sonnet/opus/haiku)へ移行した。エイリアスはopts.modelで受け付けられることを実機確認済み。**

issue #494は「`aidd-1-1-deep-task.js`にフルIDでハードコードされたモデル名が提供終了時に
無警告で壊れる」という懸念から、(1) ハードコード箇所の棚卸し、(2) Workflow `agent()`の
`opts.model`がティア名エイリアス（sonnet/opus/haiku）を受け付けるかの実機確認、
(3) 受け付ける場合はエイリアスへ移行、を行った。

**棚卸し結果（`grep -rn "claude-" .claude/workflows/ .claude/agents/`）:**
フルIDのハードコードは `.claude/workflows/aidd-1-1-deep-task.js` の7箇所のみ
（`.claude/agents/*.md`のfrontmatterは元々`model: sonnet`等のティア名のみで問題なし）。
内訳: `claude-sonnet-4-6`（draft-spec・completeness-critic-2・propose、3箇所）、
`claude-haiku-4-5-20251001`（find・score、2箇所）、`claude-opus-4-8`（verify・synthesize、
2箇所）。このうち`claude-sonnet-4-6`は現行の最新Sonnet世代（`claude-sonnet-5`）より
古い世代IDであり、実際に陳腐化が進行していたことを確認した（`claude-opus-4-8`・
`claude-haiku-4-5-20251001`は本チェック時点でまだ現行世代と一致していた）。

**実機確認（使い捨てWorkflowプローブ、2回に分けて実行）:** `agent()`の`opts.model`に
`'sonnet'`・`'claude-sonnet-5'`・`'claude-sonnet-4-6'`を指定した3並列呼び出し、および
`'opus'`・`'haiku'`を指定した2並列呼び出しを行い、いずれもエラーなく応答を得られることを
確認した。ティア名エイリアス（sonnet/opus/haiku）はフルIDと同様に`opts.model`で受け付けられる。

**対応:** `.claude/workflows/aidd-1-1-deep-task.js`の7箇所すべてをフルIDからティア名
エイリアスへ移行した（`docs/ai-config-map.md`内の対応する記述も追従して更新）。エイリアスは
その時点の「そのティアの現行モデル」に自動で解決されるため、今後個別のフルIDが提供終了に
なっても無警告で壊れる心配がなくなる。

**この変更が実質的な配分変更を伴う点の明記:** `claude-opus-4-8`→`opus`、
`claude-haiku-4-5-20251001`→`haiku`は移行前後で解決先モデルが変わらない（IDの
書き方を変えただけ）。一方`claude-sonnet-4-6`→`sonnet`は、エイリアスが現行世代
（本チェック時点でSonnet 5系）に解決されるため、実質的にモデル世代が上がる（draft-spec・
completeness-critic-2・proposeの3エージェントが対象）。これは意図的な副作用であり
「配分方針の再設計」ではなく「陳腐化した固定世代を現行世代へ追従させる」という位置づけ。

**eval before/afterを実施しなかった理由（issue注意点の未消化事項）:** issue本文は
「配分の変更を行う場合は`scripts/eval-sweep-recall.sh`4層＋`npm run eval:workflows db-impl`
でbefore/afterを取る」ことを求めていたが、両evalのfixtureが検証するagentType
（sweep-ui/data/db/types、implementer）は、今回変更した7エージェント（draft-spec・find・
verify・completeness-critic-2・propose・score・synthesize）のいずれとも一致しない
（既存evalは`aidd-phase1.js`・`aidd-phase2.js`側の一部エージェントのみを対象にしており、
`aidd-1-1-deep-task.js`固有のフェーズ用fixtureはまだ存在しない）。そのため、既存evalの
before/after比較はこの変更の品質影響を測定する手段として機能しない。
issue #496の運用ルールに従い`npm test`・`scripts/eval-sweep-recall.sh sweep-ui`・
`npm run eval:workflows db-impl`は実行し全て green（`docs/agents/eval-runs.jsonl`に記録）
だが、これは「ワークフローファイル全体が壊れていないことの一般的なスモークテスト」であり、
このモデル世代交代自体の精度・コストへの影響を測定するものではない。draft-spec/find/verify/
completeness-critic-2/propose/score/synthesize向けのeval fixture新設は本issueのスコープ外
としており、精度影響を厳密に測定したい場合は別issueで着手が必要（未着手のまま残る既知の
限界）。

**baselineスナップショット:** `.claude/workflows/aidd-1-1-deep-task.js`の`model:`行を変更した
ため、`scripts/check-agent-baseline-freshness.sh`（issue #429）のCI警告対象に該当する。
同一PRで`scripts/snapshot-agent-baseline.sh`を実行し`docs/agents/baselines/2026-07-23.json`
を追加した。

## なぜtest/lintゲートの誤差許容率を「0件」に設定し、既存のCI job（ci.yml→node-check.yml経由）にlintの--max-warnings=0を追加したか（OBL7評価設計タスク）

**結論: 単体テスト・lintのいずれも失敗0件・警告0件を合否ラインとし、flaky再試行の余地を持たせない。既存のe2e/RLS統合テストのみ`playwright.config.ts:17`のCI内1回リトライを踏襲する。**

2026-07-22のmentor評価（[[project_obl7_kgi_direction]]、Codex側ログ）で、既存の3ゲート
（test/lint/RLS静的チェック）が「動くか/動かないか」のpass/fail判定はあるが「何%まで
誤判定を許容するか」という数値的な合格ラインを事前定義していない点を指摘された
（根拠: `router-risk.js`の346万トークン消費インシデント、issue #500で対応済み）。

調査の結果、`npm test`（vitest単体テスト、183ファイル/1402件）と`npm run lint`は
`.github/workflows/ci.yml`が`node-check.yml`（Reusable Workflow）経由で`test`・`lint`・
`typecheck`の各jobとして既にPRごとに実行していることを確認した（PR #596で導入済み、
CI上のcheck名は`CI / test`・`CI / lint`）。新規CI jobの追加は不要だったため、今回は
既存jobに対する閾値の明文化と、lintの`--max-warnings=0`追加のみを行った:

- **単体テスト（vitest、`CI / test`）**: 失敗許容率0%（1件でも失敗したらred）。単体テストは
  外部I/Oに依存しない前提のため、flakyを許容する理由がない。flakyが実際に発生した場合は
  「テストの独立性を壊す実装がある」というバグ報告として扱い、閾値を緩めて誤魔化さない
- **lint（`CI / lint`）**: `package.json`のlint scriptに`--max-warnings=0`を追加し、警告も
  含めて0件を合格ラインにした。これがないと`npm run lint`は警告があってもexit 0のままで、
  CI上のcheckが警告を検知できなかった。既存の2件の警告（未使用eslint-disableコメント）は
  同PRで解消済み
- **e2e/RLS統合テスト（`e2e.yml`の`test:integration`・`test:e2e`）**: 今回は変更していない。
  `playwright.config.ts:17`が既にCI環境でのみ`retries: 1`を設定しており、これを
  「ブラウザ操作特有の一過性の不安定さを1回まで許容し、2回連続失敗なら実装側の問題として扱う」
  という既存の閾値と位置づけて明文化した

[[なぜCI品質ゲートの失敗が赤バツ表示止まりで、マージボタン自体は止められないか]]の制約により、
これらは全てPR上の可視化に留まる（`docs/agents/decisions.md`参照）。

**How to apply:** 今後新しいCI jobやテストスイートを追加する際は、追加と同時に「失敗0件」
「警告N件まで」のような数値を本エントリに準じて明記する。「後で閾値を決める」順序ではなく、
mentorスキルの判断軸（閾値を先に決めてからゲートを作る）に従うが、今回は既存のci.yml/
node-check.ymlが既にtest/lintを実行していたため、新規job作成ではなく既存jobへの閾値明記と
lint scriptの`--max-warnings=0`追加のみをまとめて行った。

## なぜトークン量のデフォルト上限（原因非依存のサーキットブレーカー）をWorkflow内に追加したか（2026-08-06 mentor評価）

**結論: `budget.total`（ユーザーの「+500k」等の明示予算）が未設定でも、累計出力トークンがworkflow固有のデフォルト上限を超えたらフェーズ境界・ループ先頭で中断する量ベースの保険を`aidd-1-1-deep-task.js`と`aidd-phase2.js`に追加した。**

`router-risk.js`の346万トークン消費インシデントは、issue #500で根本原因（changedFiles空時の
キーワード誤判定によるルート誤選択）を修正済みだが、これは原因別の個別対策であり、
「別の原因で暴走した場合に量で止める」汎用の上限はコード上どこにも存在しなかった
（2026-08-06のmentor評価指摘）。既存機構の棚卸し結果:

- Workflowツール本体の`budget.total`ハード強制（超過で`agent()`がthrow）は、ユーザーが
  「+500k」等を明示したときだけ発動するopt-in
- `budget-guard.js`（issue #442）は`aidd-1-1-deep-task.js`のSweepループ限定で、かつ
  `budget.total`未設定なら素通りする後方互換設計
- `/goal`のターン数上限はWorkflow外のセッション自走向けで、設定有無を機械検知できない
  自己申告（`undetectable-rules-inventory.md`記載）

つまり欠けていたのは「指示が無いときのデフォルト上限」のみ。`budget.spent()`は
`budget.total`未設定でも呼べるため、正本`lib/budget-guard.js`の`isDefaultCapExceeded`
（`total`設定時はWorkflowツール本体に委ねてfalse、未設定時のみ`spent() >= defaultCap`で判定）を
両workflowへインライン複製し（同期は`budget-guard-sync.test.js`）、以下の位置で判定する:

- `aidd-1-1-deep-task.js`（上限2,000,000トークン）: Sweepループ継続条件・Find前・
  Adversarial Verify前（指摘件数比例でopusが起動する最高単価フェーズ）
- `aidd-phase2.js`（上限2,500,000トークン）: Contract+DB前・Implement前・Review差し戻し
  ループの各ラウンド先頭

上限値はいずれも仮置き（346万インシデントを確実に止められ、正常収束時の想定消費を大きく
上回る値）で、実測の裏付けは薄く運用しながら再調整する前提（`MIN_BUDGET_FOR_SWEEP_ROUND`と
同じ位置づけ）。`budget.spent()`はメインループと全workflowを合算したターン累計のため、
このworkflow単体の消費量より大きく出る（=安全側に倒れる）点に注意。

**既知の限界（意図的にスコープ外）:** Workflow外、つまりメインセッションが手動でターンを
重ねる暴走は引き続き`/goal`頼みで自己申告のまま。hookからトークン量を機械測定する手段が
現状無く、statusline可視化（issue #446）止まりが現実的なため、今回は対象にしていない。

**How to apply:** 新しいWorkflowスクリプトに反復構造（ループ・リトライ）や台数可変の
フェーズを追加する際は、`isDefaultCapExceeded`をインライン複製し（`budget-guard-sync.test.js`の
`WORKFLOW_FILES`にも追加）、workflow固有の`DEFAULT_TOKEN_CAP`を根拠コメント付きで定める。

## なぜスキル本文（SKILL.md）のサイズをトークンではなく「文字数5,000」で構造テストするか（issue #716）

Claude Code は compaction 後に起動済みスキル本文を再注入するが、1スキル 5,000 トークン・合計
25,000 トークンで打ち切る（先頭を残し末尾を捨てる）。`handoff-format` のように作業終盤で使う
スキルは compaction 後に呼ばれやすく、末尾の 4 値規約や必須見出しが切れると Stop hook
（`check-handoff-format.sh`）の警告を誘発する。

2026-09-05 の実測では、バイト数（6.7KB）を見て「上限付近」と誤認していたが、文字数は 3,248 で
最悪ケース（1文字=1トークン）でも上限の 65% だった。日本語は 1 文字 3 バイトのため、バイト数は
トークンの指標にならない。API の count_tokens はセッション環境から使えない（API キー参照が
auto mode classifier に拒否される）ため、tokenizer に依存しない「文字数 ≤ 5,000」を上限に置いた。
実トークンは日本語 1〜2 文字/トークン・ASCII 3〜4 文字/トークンなので、この閾値は安全側に倒れる。

正本は `scripts/check-skill-size.test.sh`（CI `hooks-test`）。対象は `.claude/skills/` と Codex 側
ミラー `.agents/skills/` の両方。文字数は `jq -Rs 'length'`（コードポイント数）で数える
（`wc -m` はロケールが C だとバイト数を返す環境があるため使わない）。

**How to apply:** テストが RED になったスキルは、Stop hook が検知する見出しや 4 値規約などの
最重要指示を SKILL.md の冒頭へ寄せ、事例・経緯は `references/` へ分離する（agentskills.io の
progressive disclosure: name+description → 本文 → 参照ファイルの 3 層）。閾値を上げる場合は
公式 compaction 仕様の変更を確認してからにする。
