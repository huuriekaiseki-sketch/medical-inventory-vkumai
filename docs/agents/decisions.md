# 設計判断の記録

「なぜその設計・ルールにしたか」を記録する。ルール本体は `common.md` を参照。
ここは理由だけを書き、実装詳細やハウツーは書かない。

DBスキーマ固有の「なぜ」は、まずそのマイグレーションファイルの `-- WHY:` コメントを正とする。
ここには複数マイグレーション・複数レイヤーにまたがる横断的な決定だけを書く（二重管理を避けるため）。

**運用ルール（issue #491で追加）:**
- 誤りと判明した記述は、追記（「訂正:」等）ではなく本文を書き換える。経緯が必要な場合のみ1行の注記に圧縮し、詳細はgit履歴に委ねる
- 同一のインシデント・事例は1箇所にのみ記述し、他のエントリから参照する場合はリンクで参照する（再記述しない）
- 各エントリの冒頭に太字1行で結論を書く（本文を読まなくても結論が分かるように）
- リポジトリ・コミット履歴・sync testが既に記録している実装詳細（修正したファイルの列挙等）は書かない。一般化できる教訓は[`known-failure-patterns.md`](./known-failure-patterns.md)のチェック項目として書く

## 分野別ファイル（issue #491で分割）

エントリ数・分野が増えたため、下記の「なぜdomain.md/decisions.mdを単一ファイルで始めたか」が定めた分割条件（1ファイルが長くなった、または分野が3つ以上に増えたタイミング）に従い分割した。このファイルはTOCと、特定の分野に属さない横断的な原則のみを残す。

- [`decisions/db-rls.md`](./decisions/db-rls.md) — DBスキーマ・RLS施設分離・スキーマドリフト検知・テスト環境データ衛生
- [`decisions/aidd-pipeline.md`](./decisions/aidd-pipeline.md) — Workflow DSL・TRI/RISKルーター・品質ゲート・hook
- [`tooling-decisions.md`](./tooling-decisions.md) — 公式機能・プラグインの導入可否判断（issue #486でcommon.mdから分離した際に新設。#491でこちらへ統合し、decisions.md側は各エントリからのリンクのみに変更）

## なぜCI品質ゲートの失敗が赤バツ表示止まりで、マージボタン自体は止められないか

**結論: このリポジトリはGitHub Freeプランの非公開リポジトリであり、branch protection（必須ステータスチェック）APIが使えないため。**

`gh api repos/<owner>/<repo>/branches/main/protection`は`403 Upgrade to GitHub Pro or make
this repository public to enable this feature`を返す（2026-08-07確認）。このため
test/lint/RLSいずれのCI jobも、PR画面にfailing checkとして表示することはできるが、
「必須チェック未達なら[Merge]ボタンを押せなくする」という機械的ブロックは設定できない。
公開リポジトリ化またはGitHub Proへのアップグレードをしない限りこの制約は解消しない。

**How to apply:** test/lint/RLSゲートの「閾値超えで止める」という表現は、いずれも
「PR上に赤バツを出す」までを指し、マージそのものの機械的停止を意味しない点を、新しい
ゲートを追加・説明するたびに前提として書く。実際の強制力は、AIDDパイプライン内の
`quality-gate.js`によるdeny-by-default判定（サブエージェント実行フロー内でのみ機能、
`docs/agents/decisions/aidd-pipeline.md`参照）と、人間レビュアーが赤バツを見て
マージを手動で控える運用に依存する。

## なぜdomain.md/decisions.mdを単一ファイルで始めたか

**結論: エントリ・分野が少ないうちは単一ファイルで始め、分野が3つ以上に増えたタイミングで分割する前提にした（issue #491で実際に分割した）。**

grill-with-docsスキルの `CONTEXT.md` + `docs/adr/`（未採用。分野別に分割するパターン）も検討したが、
用語・決定候補がまだ少ない段階（各6〜7件程度）で分割すると、1ファイルに数行しかない
「空気を運ぶだけのファイル」が増えるだけだった。

1ファイルが長くなった、または分野が3つ以上に増えたタイミングで、目次ファイル＋分野別ファイルに
分割し直す前提にしている。単一ファイルのまま無限に肥大化させる想定ではない。

**実際の分割（issue #491）:** 834行・28エントリまで増え、DB/RLS・AIDDパイプライン・ツール導入可否の
3分野を優に超えたため、上記の分割条件に該当した。db-rls.md・aidd-pipeline.mdの2ファイルへ分割し、
ツール導入可否判断はissue #486で新設済みのtooling-decisions.mdへ統合した（新規ファイルを増やさず
既存の分離先と役割を合わせるため）。

## なぜセッション終了時のドキュメント更新提案を「提案のみ」にし、自動追記にしなかったか

**結論: Stop hookは更新候補を提案するのみに留め、確認なしでdomain.md/decisions.mdへ直接書き込む設計にはしなかった。**

Stop hookでdomain.md/decisions.mdの更新候補を提案する仕組みを作ったが、フックが確認なしで
直接ファイルに書き込む設計にはしなかった。

decisions.mdは「後戻りしづらい・記録がないと後から謎・本当にトレードオフがあった」という
高い基準で厳選する設計にしている。AIの誤判断（ドメイン理解が浅い状態での用語追加、trivialな
変更のADR化等）がそのままファイルに書き込まれると、この基準が形骸化し、ファイルの信頼性が
落ちる。書くかどうかの最終判断は人間が行う。

## なぜ新しい運用ルールに「検知手段を先に決める」原則を導入したか（issue #339）

**結論: 新しい運用ルールは、破られたことを機械的に検知する手段を先に決めてから書く。検知手段を設計できないなら、そのルールがprose追加に見合う価値を持つか自体を疑う。**

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
方針にした（この方針に沿って、common.md自体もissue #486で毎セッション必須ルールと参照ドキュメントに分割している）。

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
引き継ぎフォーマット実施検知）も実装済み: 前者は`scripts/check-run-manifest-presence.sh`
（issue #444）、後者は`scripts/check-handoff-format.sh`（issue #524、PR本文経由の引き継ぎのみ
対象。セッション終了報告・`docs/sessions/`経由は引き続き未検知）。

## なぜ新しい検知メカニズムに「アクチュエータ（検知後に誰が直すか）」も先に決める原則を追加したか（issue #578）

**結論: 新しい検知hookを追加するときは、センサー（検知手段、issue #339原則）だけでなく、検知後に
誰が是正するか（block / recovery-queue登録による自動復旧 / ask（実行前の人間確認ゲート） /
warning-only（人が読んで対応）のいずれか）も先に決める。決めずに追加すると、検知hookの数は
増え続けるのに「本当に閉じているループ」の比率は上がらない。**

2026-08-01のmentor設計レビュー（ループ/ハーネスエンジニアリング観点）で、issue #339の3層
（機械強制／機械検知（事後）／自然言語のみ）はセンサー側の分類であり、検知**後**の是正動作
（アクチュエータ）については別軸で分類されていないことが指摘された。実際に棚卸しすると
（[`actuator-inventory.md`](./actuator-inventory.md)参照）、`.claude/settings.json`に登録された
検知hook約20件のうち、機械的にblock/askするものは2件（`check-direct-ddl-execution.sh`の
deny、`check-skip-marker-write.sh`のask）、recovery-queueへ自動登録し次回セッションで
自動的に目の前に出すものが2件（`check-workflow-interruption.sh`、`check-gap-check-state.sh`）
のみで、残り約15件はすべて「systemMessageを人（またはセッション自身）が読んで判断する」
warning-onlyだった。検知hookの本数だけを見るとループが充実しているように見えるが、実態は
「センサーは多いがアクチュエータは少ない」という偏りがあった。

**原則:** 新しい検知メカニズムを追加する際は、issue #339の「検知手段を先に決める」に加えて
「検知後、誰が・どう是正するか」も同時に決める。是正が機械（block/deny/自動復旧）でできない
場合でも、それ自体は悪ではない（停止①②のように人間判断が必須な箇所は意図的にwarning-only
またはask止まりにすべき）。ただし「warning-onlyにした」という判断は暗黙にせず、
[`actuator-inventory.md`](./actuator-inventory.md)の棚卸し表に反映し、意図的にwarning-onlyに
したのか、単に手が回っていないだけなのかを区別できる状態を保つ。

## なぜseed.sqlを新規作成せず、既存のテストヘルパー方式を正式設計として採用するか（issue #647）

**結論: `supabase db reset`後のテストデータ投入は、新たに`supabase/seed.sql`（未採用）を作らず、
`supabase/__tests__/integration/helpers/seed-rls-idor.ts`のテストヘルパー関数方式を正式な設計
として採用し続ける。**

調査時点で、seed用のテストデータ投入は既に4箇所（case/consumable/loan-orders/loan-returns
のRLS/IDOR統合テスト）でヘルパー関数方式による運用実績があり、`supabase/seed.sql`は存在しない
（不在は意図的な欠落ではなく、単に別方式が既に確立されていたため必要がなかった）。ここで
`seed.sql`を新規に導入すると、以下の理由で二重管理になる:

- `seed.sql`は`supabase db reset`時にSQLとして一括投入される静的データである一方、ヘルパー関数
  方式は各テストが必要とする施設・ユーザー・RLSシナリオをテストごとに動的に組み立てられる。
  両方式が並存すると、「このテストデータはどちらの経路で入っているか」を都度確認する必要が生じ、
  データの発生源が分裂する
- 既存4箇所のテストは既にヘルパー関数方式に依存しており、書き換えコストをかけてまで
  `seed.sql`に統合するメリットがない（動作しているものを壊すリスクの方が大きい）

このため、新規のシード投入ニーズが発生した場合も、まず`seed-rls-idor.ts`と同様のヘルパー関数
方式で対応することを正式設計とする。将来的に`seed.sql`が必要になるケース（例: ローカル開発者が
`db reset`直後に手動でUIを触るための最低限のデモデータ）が出てきた場合は、テストデータとは
別目的であることを明記した上で改めて検討する。

### 補足: consumables.jan FK違反時の境界条件（issue #647 レビュー指摘）

`consumables.jan`は`products(jan)`へのFK（`20260714000004_link_consumables_jan_and_validate_fk.sql`）
であり、SPEC本文の受け入れ条件は「品名・用途が空白のみの場合は400エラーになる」のみを規定して
いた。存在しないJANを指定した場合の挙動がSPECに未記載だったため、レビューで指摘された。

対応として、`src/lib/consumables/repository.ts`のFK違反(Postgresエラーコード`23503`)を
`ClientVisibleError`として翻訳し、`src/app/api/consumables/route.ts`でこれを400として返すよう
修正した（従来は`toClientErrorMessage`によるサニタイズで汎用500になっていた）。クライアント入力
（存在しないJAN）に起因するエラーであり、サーバ内部の問題ではないため400が適切と判断した。

### 補足: 同一施設内でのJAN・品名の重複登録可否（issue #647 レビュー指摘）

SPECの受け入れ条件・DBスキーマ(`consumables`テーブル)ともに、同一施設内で同一JANや同一品名を
複数回登録することを禁止する一意制約は定義されていない。これは意図的な設計判断であり、今回の
スコープでは重複防止を追加しない: 消耗品は同じ品名・JANでも仕入先やロットが異なるケースが
運用上あり得るため、一意制約を先回りで課すとSPECにない業務要件を勝手に追加することになる。
重複を防ぎたいという要件が実際に出てきた時点で、UI側の警告表示かDB制約かを含めて別途検討する。

## なぜテスト一覧（test-matrix.md）と04の4値化を先に入れ、機械導出（derive）と約束カタログを後続PRに分けたか

**結論: kojigyo-zei-rag で導入した3点セット（テスト一覧・約束カタログ・必須テストの機械導出）を
vkumai へ移植するにあたり、PR①=一覧＋引き継ぎメモ04の4値化（文書とスキルのみ）、
PR②=`router-risk.js` を土台にした「今回必須 / 今回不要（理由付き）」の機械導出、
PR③=auth / RLS / facility 境界に限定した約束カタログ、の3つに分割する。**

分割理由:

- PR② は `.claude/workflows/lib/` に触るため、ワークフロー eval 義務
  （`.claude/rules/workflow-eval-requirement.md`）と sync test が絡む。文書のみの PR① と
  レビュー単位を混ぜると、文書の議論とスクリプトの議論が同じ PR で交錯する
- 一覧が先に存在しないと、derive の `not_required` の理由文が対応づく先が無い。kojigyo でも
  一覧・カタログ（PR #8）→ lint/型検査の実装（PR #10）の順で進めた
- kojigyo の derive は bash の `case` 表でパスを分類しているが、vkumai には既にパスベースの
  リスク分類の正本（`router-risk.js` の `classifyRoute`、issue #286・#456・#457）がある。
  bash の表を並行で持つと必ず乖離するため、PR② は正本側に出力を足す形にする
- 約束カタログは9列の表で、全域に書くと保守されなくなる。kojigyo でも「守るテスト」列は
  ファイルの存在しか機械検査できず、テスト名のリネームに追従しない穴が残った。vkumai では
  テスト側に `P-xxx` を書き「カタログの全 ID がテストコードに出現する」を逆方向で検査する
  設計にし、まず価値が最も高い認可境界だけに絞る

### なぜ状態記号に ❌ を使わず ⬜ 未整備 にしたか

kojigyo で「❌ 無い」と書いた行が「失敗・問題あり」と読まれた（2026-09-02、ユーザー指摘）。
「まだ用意していないが、時期とやり方は決めてある」状態は失敗ではないため ⬜ に改め、引き継ぎメモ
04 の「⬜ 未実施」と体系を揃えた。

### なぜファイル名を test-inventory ではなく test-matrix にしたか

`router-risk.js` の `RISK_DOMAIN_KEYWORDS` に `inventory`（在庫ドメイン）が含まれ、
`test-inventory.md` という名前はパスベースの高リスク判定に恒久的に誤一致する。設計書を書いた
時点で PreToolUse hook（`scripts/check-run-manifest-presence.sh`）が実際に警告した。
ドメイン語と衝突しない `test-matrix` を採用した。同じ理由で、今後 `docs/` 配下に
`auth` / `facility` / `tenant` / `organization` / `inventory` / `rls` / `policy` を含む
ファイル名を付けるときは、そのドメインの変更として扱われてよいかを先に確認すること。

## なぜ derive をエンジン（共通）とルール表（固有）に分け、高リスク判定をルール表に書かないか（PR②、2026-09-04）

**結論: `scripts/lib/derive-test-selection.mjs`（入力解析・評価・出力。パス表を持たない）と
`scripts/lib/derive-test-selection.rules.mjs`（一覧の1行 = 1ルール）に分け、高リスクパスの判定は
`.claude/workflows/lib/router-risk.js` の `classifyRoute` の戻り値（`matchedPaths`）を参照する。**

- 2026-09-04 に「vkumai はフォーマット（列・4値・ID 規約）と構造テストの正本として派生リポジトリへ
  配る側」と決めた。派生先が書き換えるのはルール表だけ、という形にしておくと、プラグイン化の際に
  エンジンをそのまま持ち上げられる（`portability-inventory.md`）
- kojigyo-zei-rag の derive は bash の `case` 表に高リスクパスを持ち、`router-risk.js` 相当の正本と
  二重管理になっていた。vkumai では正本が既にあるため、そこに並行の表を作らない
- `integration-gate.yml` の `paths` 条件のうち高リスク判定に無いもの（`supabase/__tests__/**`）だけ
  ルール表側に持つ。将来 `paths` を増やしたらルール表にも足す（両方を読む構造テストは今回入れて
  いない。`paths` は CI が回す条件、ルール表はローカル実行義務を出す条件で、一致が必須ではないため）

### なぜ一覧に derive キー列を足すとき、構造テストの検査も同時に足したか

列は機械が検査している間だけフォーマットとして機能する。kojigyo の一覧は形式が先にあり検査が
後付けで、CI ジョブ名・理由列・列ずれの3穴が vkumai への移植時に初めて見つかった。derive キー列は
最初から「一覧のキーがルール表に実在する / ルール表の全キーが一覧に1回ずつ現れる / 種別名と
実施タイミングが一致する」を `check-test-matrix.test.sh` で双方向に突合し、fixture で RED 方向も
固定する。今後列を足す PR は、同じ PR で検査を足すこと。列を変える変更は派生先全部に効くため
破壊的変更として扱う。

### なぜ 04 表の4値検知を block ではなく行の名指し警告にしたか

フォーマットに収まらない行は「書き方が雑」か「一覧に無い種類の確認が出てきた」かのどちらかで、
後者は製品側に新しいリスクが出た合図になる（kojigyo の約束カタログでは、列が欠けていた P-083 が
「守るテストが表から読めない」状態、列が余っていた P-084 が「2つの約束を1行に押し込んでいた」
状態だった）。block すると書く側が行を削るか無理に列を埋めて合図が消える。無言スキップだと見逃す。
外れた行を種別名で名指しして人が見る、が正解なので warning-only にし、警告文にその2択を書いた。

## なぜ約束カタログを auth / RLS / facility 境界に限定し、ID をテスト側に書いて逆方向で検査するか（PR③、2026-09-04）

**結論: `docs/agents/promise-catalog.md` は認証・施設境界・admin 境界・AAL2・RLS 衛生・施設境界に
関わる DB 制約だけを載せ、守るテストの `describe` 名に `P-xxx` を書き、
`scripts/check-promise-catalog.test.sh` が「カタログの ID が守るテストのファイル内に実在する」と
「テストコードの ID が全てカタログにある」を双方向で検査する。**

- 限定する理由: 9 列の表を全域に書くと保守されなくなる（kojigyo の実感）。vkumai で破ると一番
  困る約束は施設境界と認可なので、そこだけを最初に固定する。UI・取込はテスト一覧の種別で足りる
- ID をテスト側に書く理由: kojigyo のカタログは「守るテスト列のファイルが存在する」しか検査せず、
  テスト名のリネーム・削除に追従しなかった（列が欠けた P-083、列が余った P-084 が通っていた）。
  ファイルの中に ID 文字列があることを検査すれば、テストを消したときにカタログ側が落ちる
- 孤児 ID も違反にする理由: テストに ID を書いたのにカタログに行が無い状態は「約束が表に無い」
  状態であり、フォーマットに収まらない合図として見せたい
- `describe` 名に書く理由（コメントだけにしない）: vitest / Playwright の実行ログに ID が出て、
  失敗した約束を ID で追える
- 守るテストが無い約束を `未` で載せる理由: 「無い」を表に書いておくと、一覧の ⬜ / 🟡 と対応づき、
  「今回不要」と「穴」の区別に使える（P-017 API Route 直接攻撃の自動化、P-052 同時実行）

## なぜ依存追加を PreToolUse の ask で止め、監査は CI で hard fail にし、差分レビューは warning にしたか（2026-09-04）

**結論: 「追加の瞬間」は `check-dependency-change.sh`（ask。Codex は deny）で人間確認を強制し、
「既知脆弱性」と「ロックの出所」は CI で失敗させ、「用途・代替案の記述」は Stop hook の警告に
とどめる。**

- ask にした理由: 依存追加は第三者コードを増やす設計判断で、理由・代替案・影響は人にしか判断
  できない。deny だと正当な追加まで人が手動で `npm install` することになり、AI に実装を任せる
  意味が薄れる。ask なら「報告してから承認」の入口を機械で挟める。Codex は ask 未対応なので
  deny（既存の `codex-skip-marker-deny.sh` と同じ変換）
- `npm ci` / 引数なし `npm install` を対象外にした理由: lockfile どおりに入れ直すだけで依存を
  変えない。ここまで ask にすると日常の作業が止まり、hook が外される
- 監査とロック出所を hard fail にした理由: 機械的に白黒がつき、誤検知の余地が小さい。導入時点で
  本番依存に high 4 件（next 16.2.9 経由）があったので、同じ PR で next 16.3.4 へ上げて 0 件に
  してから有効化した（`--omit=dev` なので dev 側の既知脆弱性は対象外。四半期の見直しで確認）
- 差分レビューを warning にした理由: 「依存の変更」の記述の有無は見られるが中身の妥当性は
  機械で判定できない。block にすると空の見出しを置いて通す圧力が生まれる（04 表の 4 値検知と
  同じ判断）
- 検査名ごとに「分かること / 分からないこと」を `known-failure-patterns.md` に表で書いた理由:
  npm audit が緑＝安全、と読まれるのを防ぐ。役割の違う検査をひとまとめに「テスト済み」と
  報告させない

## なぜ docs の整合性検査を「リンク・アンカー・パス言及」の3種に限定し、削除済みパスの言及には歴史的マーカーを要求するか（issue #714）

OpenAI の Harness engineering 事例（2026-02）は、AGENTS.md を「地図」、docs/ を「エージェント可読の
知識庫」とし、ドキュメントの腐敗を CI で機械的に抑えることを重視している。vkumai の docs/agents/ は
21 ファイル・約 300KB に達していたが、リンク切れ・言及スクリプトの不在を検査する仕組みが無く、
圧縮（issue #486・#542）も人手だった。2026-09-05 の初回実行では 9 件の違反が出て、うち 2 件は
実際のドリフト（`.claude/security-patterns.yaml`（存在しない）と書かれていたが実体は `.json`、
`decisions.md` へのアンカーが見出しの記号・空白の扱いを誤っていた）だった。

**検査を3種に限定した理由:** 意味的な陳腐化（「issue #NNN で対応済み」の状態変化など）は LLM か
`gh` が必要で、CI の hooks-test（checkout のみ・認証なし）では回せない。まず機械的に判定できる
ものだけを CI に載せた。クローズ済み issue の言及は、その後「保留・未対応の文脈で参照している issue が CLOSED」の場合だけを `scripts/lib/check-docs-issue-refs.mjs` が warning-only で出す（docs-integrity-check.yml、gh 依存。全参照を見ると数百件の履歴記述が鳴るため文脈で絞った）。

**削除済みパスに歴史的マーカーを要求する理由:** decisions や observability-internals は「かつて
あった `scripts/x.sh`（削除済み）を置き換えた」という経緯を書く場所であり、言及そのものは正当。しかし
読み手（後任 AI）にとって「今も存在するか」が本文から読めないのは同じく腐敗である。同じ行に
`削除済み` / `統合済み` / `未採用` 等の語があれば違反にしない、という規約にすることで、検査を
通すための修正がそのまま読み手への注記になる（`HISTORICAL_MARKERS`、
`scripts/lib/check-docs-integrity.mjs`）。

**docs だけの PR で回す経路:** `ci.yml` は docs/** と CLAUDE.md / AGENTS.md を paths-ignore して
いる（Actions 無料枠対応）ため、hooks-test だけでは docs のみの PR で検査が回らない。
`.github/workflows/docs-integrity-check.yml`（eval-runs-freshness-check.yml と同型の軽量単独
workflow）を docs 側の paths で起動し、コード側の変更で回る hooks-test と合わせて実質すべての PR を
カバーする。paths-ignore 自体を外して ci.yml 全体を回す案は、docs 1 行の修正で build まで回り
無料枠を食うため採らなかった。

**How to apply:** ファイルを削除・改名したら、`node scripts/lib/check-docs-integrity.mjs` を
実行して言及箇所を洗い出し、残す言及には歴史的マーカーを添える。新しい見出しへリンクする
ときはアンカーを手で書かず、`slugify`（同スクリプト）の出力を使う。

**初回 CI で判明した落とし穴（2026-09-05）:** ローカルでは GREEN だった検査が CI では
`.claude/settings.local.json` の言及 3 件で RED になった。原因は、このファイルが各自の
グローバル `~/.config/git/ignore` でしか ignore されておらず、CI の checkout では
`git check-ignore` が「ignore 対象ではない」と答えたこと。「git ignore 対象は実在しなくても
違反にしない」という規則は**リポジトリの `.gitignore`** にしか依存できないので、
`.claude/settings.local.json` を `.gitignore` に明示した。ローカル green・CI red の典型で、
グローバル ignore に頼ったパスは他にも同じ形で壊れうる。

## なぜ TRI/RISK 基準の AGENTS.md / common.md 重複を残し、router-risk.js を正本にした同期テストで固定したか（issue #715）

**結論: AGENTS.md（Codex が読む）と docs/agents/common.md（Claude Code が CLAUDE.md から
@import で読む）の「TRI/RISK 機械判定基準」節は両方に本文として残す。正本は
`.claude/workflows/lib/router-risk.js` とし、`.claude/workflows/lib/__tests__/tri-risk-docs-sync.test.js`
が「正本の全パス接頭辞・middleware.ts・proxy.ts・全ドメイン語が両節に含まれる」ことと
「両節の基準本体が一字一句一致する」ことを `npm test` で検査する。**

3 案を比較した。

- **案A（AGENTS.md をポインタ化）:** 重複は消えるが、Codex は起動時に AGENTS.md しか読まない
  ため、常時効かせたい高リスク判定が「必要なら common.md を読め」という間接参照になる。
  [`parallel-agent-work.md`](./parallel-agent-work.md) の「2つのコピーが食い違ったとき必ずバグに
  なるものだけを共有する」原則は、まさにこの基準を**両方に本文として持ち、機械で同期する**
  ことを想定している。共存テンプレートの原則 10（並行作業禁止を AGENTS.md / CLAUDE.md の
  両方に明文化）と同じ扱いにするのが筋。却下。
- **案B（重複を残し同期テスト）:** 採用。既存の prompt-sync / router-risk-sync と同型で、
  基準を変える PR は正本・両 doc の 3 箇所を同時に直さないと RED になる。
- **案C（CLAUDE.md に @AGENTS.md）:** 公式推奨だが、常時ロード量が約 3,600 文字増え
  （issue #711 の実測で既に公式例の約 6 倍）、かつ AGENTS.md には Codex 固有の節
  （`.codex/` 設定・ask 未対応のラッパー）があり Claude に読ませる意味が無い。却下。

**Codex 実機確認を省いた理由:** AGENTS.md の本文を変えていないため、Codex 側の読み込み結果は
変わらない。案A を採る場合にのみ `codex --ask-for-approval never "Summarize current instructions."`
での確認が必要だった。

**How to apply:** TRI/RISK 基準（高リスクパス・ドメイン語・ファイル名規則）を変えるときは
`router-risk.js` → `AGENTS.md` → `common.md` の順に 3 箇所を同時に直す。テストが RED に
なったら「片方だけ直した」合図。基準本体の文言を整えるときも両 doc を同じ文字列に揃える。

## なぜ eval-runs 鮮度チェックを warning から失敗（exit 1）に変え、免除は PR 本文の `eval-skip: <理由>` にしたか（2026-09-05）

**結論: `.github/workflows/eval-runs-freshness-check.yml` は `.claude/workflows/*.js` を変えた PR で
`docs/agents/eval-runs.jsonl` が未更新なら `::error::` を出して失敗する。eval が不要な変更は PR 本文の
行頭に `eval-skip: <理由>` と書けば `::notice::` で通る。理由が空なら失敗。**

2026-07-23 の導入時（issue #496）は「まずは warning で開始」とした。その後 `.claude/workflows` を変えた
PR は 3 件（#627 #679 #693）あり、いずれの run にも警告は正しく出ていたが、`::warning::` は Actions の
run を開かないと見えず、ジョブ自体は緑のため誰も気づかずマージされた。結果、eval-runs.jsonl の記録は
導入日で止まり、`docs/agents/eval-runs.jsonl` の停止を追って初めて発覚した（同日、Stop hook 3 本が
transcript 形式の変化で無音死していた別件も見つかった。[`known-failure-patterns.md`](./known-failure-patterns.md#fail-open-の-warning-only-hook-が入力形式の変化で無音のまま死ぬ2026-09-05)）。
「検知は動いているが届いていない」状態であり、届く形に変える必要があった。

2 案を比較した。

- **PR コメントを投稿する:** `pull-requests: write` 権限と重複投稿の抑止が要り、push のたびに
  コメントが積もる。得られるのは「見える化」だけで、赤 check と同じ効果。却下
- **ジョブを失敗させる（採用）:** PR の checks 一覧と `gh pr checks` に赤で出る。マージ前に
  `gh pr checks` を見る運用と噛み合う。derive が `.claude/workflows` 変更時に「ワークフロープロンプト
  eval」を必須行として出すのとも整合し、CI と 04 表の基準が揃う

**免除を本文申告にした理由:** eval は実エージェントを呼びコストがかかる。コメント修正・定数変更・
配線のみの PR に毎回 eval を強いるのは過剰で、かといって無条件の免除は元の warning と同じになる。
理由を本文に書かせれば、後から「なぜ飛ばしたか」を追える。本文はシェルに展開せず `env` 経由で
スクリプトに渡す（workflow injection 対策）。

**限界:** vkumai は Free プランで required check を設定できないため、赤でもマージボタンは物理的には
止まらない（[前掲](#なぜci品質ゲートの失敗が赤バツ表示止まりでマージボタン自体は止められないか)）。
最後の防波堤は「赤い check を見た人」であり、warning より確実に届く、という改善に留まる。

**How to apply:** `.claude/workflows/*.js` を触る PR は、対応する fixture セットで
`npm run eval:workflows <set>`（sweep 系は `scripts/eval-sweep-recall.sh <layer>`）を回して
eval-runs.jsonl の追記をコミットに含める。eval が意味を持たない変更なら PR 本文に
`eval-skip: <理由>` を書く。免除を多用し始めたら、それは fixture セットの不足の合図として扱う。

## なぜ TRI/RISK 判定の語彙を router-risk.js から aidd.config.json へ移し、既定値は「足すだけで消せない」形にしたか（issue #420 v1 セット B、2026-09-05）

プラグイン v1（[`docs/specs/plugin-v1/SPEC.md`](../specs/plugin-v1/SPEC.md)）の最重要原則は
「vkumai 専用設定をそのまま汎用プラグインにしない」。判定エンジン `router-risk.js` は 7 月試作で
そのままコピーされ、`facility` / `inventory` / `supabase/migrations/` といった語が共通側に残る形に
なっていた。エンジン（4 分岐のロジック）と語彙（どの語を高リスクとみなすか）を分け、語彙を
リポジトリ直下の `aidd.config.json`（導入先アダプター）へ移した。

**既定値を汎用語だけに絞る代わりに、設定は既定値に「足す」だけにした理由:** 設定で既定値を上書き
（置換）できる形にすると、導入先が `domainKeywords: ["corpus"]` と書いた瞬間に `auth` / `rls` /
`policy` が消え、TRI/RISK の「迷ったら高リスク側」が設定ミス 1 つで破れる。和集合にしておけば、
設定が空でも・壊れていても・キーを間違えても、判定は緩まない（緩む方向の失敗モードを構造的に
無くす）。`migration` を既定の domainKeywords に入れたのは、`supabase/migrations/` のような接頭辞は
スタック固有で既定にできない一方、パスに migration を含む変更はどのスタックでもスキーマ変更である
可能性が高いため。

**インライン複製を残した理由:** `aidd-phase1-router.js` は Workflow DSL でファイルを読めない
（[`load-bearing-workarounds.md`](./load-bearing-workarounds.md)）。そのため同じ値を
`LOCAL_RISK_CONFIG` としてインラインで持ち、`aidd.config.json` との一致を
`aidd-config.test.js` が検証する。`@aidd-local-config:begin/end` マーカーで囲んであるのは、
プラグイン生成時にその区間だけを空に置き換えるため（導入先は `args.riskConfig` で渡す）。

**代替案（却下）:** 既定値に vkumai の値を残し、導入先が上書きする。共通側に固有語が残るため
原則に反し、禁止語の構造テスト（`aidd-config.test.js`）で機械的に弾く形にした。

**How to apply:** 高リスクの語・パスを足すときは `aidd.config.json` の `risk` と
`aidd-phase1-router.js` の `LOCAL_RISK_CONFIG` の両方を直す（片方だけだとテストが RED）。
汎用語を足すときだけ `router-risk.js` の `DEFAULT_RISK_CONFIG` を直す（禁止語に注意）。

## なぜプラグイン v1 を「vkumai から機械生成する配布物」にし、層の表と禁止語検査で共通側を守るか（issue #420 セット C、2026-09-05）

7 月の試作（手コピー）は agent 名の名前空間が付かず sweep 4 体が全滅し、しかも `findingCount: 0` の
偽の正常完了に見えた（後者は issue #521 で修正済み）。手順に頼ると同じ事故が再発するため、
`scripts/build-plugin.sh` が層の表（`scripts/lib/plugin-layout.json`）に従って `dist/plugins/` を生成する。
生成物は決定的で、`--check` が CI（`scripts/build-plugin.test.sh`）で鮮度を見る。

**なぜ vkumai を正本にしたか（プラグインを正本にしない）:** vkumai は 1 日に数 PR の速度で hook が増え、
同期テスト 30 本超がその変更を守っている。プラグイン側を正本にすると開発が止まり、構造テストも
効かなくなる。「新しい仕組みは vkumai で先に作り、他リポジトリは受け取るだけ・逆流禁止」を、生成という
構造で守る。v2 以降で反転するかは v1 を 2 リポジトリで回してから決める。

**なぜ共通側に禁止語検査を置くか:** 「vkumai 専用設定をそのまま汎用プラグインにしない」が最重要原則。
コメント込みで検査するのは、コメントの固有語もそのまま導入先に配られ、後で読む人を誤らせるため。
初回の生成で 37 件が出て、うち本物の移植性バグが 1 件あった（TS 補助スクリプト 3 本の既定
`--project-dir` が個人環境のパスを直書き。cwd から導出する形に修正）。docs のファイル名
（`actuator-inventory.md` 等）は許容句として除外する（ファイル名の語の誤一致は既知の型）。

**なぜ同梱閉包を検査するか:** hook が `$SCRIPT_DIR/lib/…` を参照するとき、参照先が同じプラグインに
無ければ導入先で無音死する（fail-open）。本文の参照を機械的に集め、同梱されていなければ生成を失敗させる。
案内文だけの参照は `allowUnresolvedReferences` に理由付きで書く。

**なぜ bin/ を使うか:** agent / skill / workflow の本文は `scripts/log-agent-progress.sh` のように
リポジトリ相対でスクリプトを呼ぶが、プラグインとして配ると導入先に `scripts/` は無い。プラグインの `bin/`
は Bash の PATH に足されるので、生成時に `scripts/<bin>` を裸の名前に書き換える。

**How to apply:** 新しい hook・スクリプト・エージェントを足したら `plugin-layout.json` に層を書く
（書かなければ生成が失敗する）。共通側に置くなら固有語を本文・コメントから消す。
`bash scripts/build-plugin.sh` を実行して `dist/plugins/` の差分をコミットする。
