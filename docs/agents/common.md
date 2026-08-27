# 共通ルール（全AIエージェント共通）

このファイルは Claude Code・Codex 等、このリポジトリで作業するすべての AI エージェントが
従うべき共通ルールを定義する。ツール固有の設定（サブエージェント・スキル・ワークフロー・
開発フローのオーケストレーション等）は各ツールの入口ファイル（`CLAUDE.md` / `AGENTS.md`）
側を参照すること。

- ドメイン用語（facility・price等が何であるか）は [`domain.md`](./domain.md) を参照
- 各ルールが「なぜ」その設計になったかは [`decisions.md`](./decisions.md) を参照
- 過去に実際に再発した実装ミスのチェックリストは [`known-failure-patterns.md`](./known-failure-patterns.md) を参照（レビュー・Sweep系エージェントは必読）
- 検知手段のないルール（自然言語のみで強制力の無いルール）の一覧は [`undetectable-rules-inventory.md`](./undetectable-rules-inventory.md) を参照
- 検知hookの検知後の是正（block/自動復旧/warning-onlyのいずれか）の一覧は [`actuator-inventory.md`](./actuator-inventory.md) を参照（issue #578）

## Next.js バージョンに関する注意

This version has breaking changes — APIs, conventions, and file structure may all differ from
your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing
any code. Heed deprecation notices.

## TRI/RISK 機械判定基準（AIDDパイプライン採用条件）

変更が以下の**いずれか**に触れる場合、Sレーン（軽量レーン）は禁止。必ず M/L 扱いとし、RISK=はい と判定する：

- `supabase/migrations/` 配下のファイル
- `src/lib/supabase/` 配下のファイル
- `middleware.ts`（プロジェクト内のすべての middleware）
- パス・ファイル名・変更内容が以下のドメインに関わるファイル：
  **auth / facility / tenant / organization / inventory / RLS / policy**

この判定は人間の裁量で緩めない（機械判定）。迷ったら高リスク側に倒す。
理由は [`decisions/aidd-pipeline.md`](./decisions/aidd-pipeline.md#なぜtririsk判定を機械判定にし人の裁量で緩めないことにしたか) を参照。

`aidd-phase1-router`を経由せず直接実装に入った場合の検知（issue #444）: 上記の高リスクパスへの
Write/Edit/MultiEdit時に`.aidd/run-manifest.json`が存在しなければ、PreToolUse hook
（`scripts/check-run-manifest-presence.sh`）がブロックせず警告のみ注入する。ブロックしない
理由・鮮度判定を見送った理由は同スクリプトのコメント、経緯は
[`decisions/aidd-pipeline.md`](./decisions/aidd-pipeline.md#なぜissue-444のpretooluse-hookを警告のみdenyの二段構えにしたか)を参照。

### 第5カテゴリ: パイプライン自体のメタ改修（issue #457）

上記のTRI/RISK基準は「プロダクトコード変更」を前提にしており、`.claude/workflows/`・
`.claude/agents/`・`docs/agents/`配下のみを変更する「パイプライン自体のメタ改修」タスクには
機械的に2つの誤判定を起こしていた。

- **症状1（キーワード誤検知）**: taskDescriptionに「DB/RLS/authには触れない」という
  否定文を含めても、"auth"/"facility"/"rls"等の単語が単純文字列一致し、changedFilesが
  実際は高リスク領域に一切該当しない（matchedPaths: []）にもかかわらず深掘り調査
  （`aidd-1-1-deep-task`）へ誤って振り分けられる
- **症状2（無駄な4軸Sweep）**: 軽量Sweep（`aidd-phase1`）の4軸（UI/データ/DB/型）は
  プロダクトコード向けの分類軸であり、`.claude/workflows/*.js`のようなツール層の変更には
  UI/データ/型の3軸が「対象コードがそもそも存在しないので当然指摘なし」を返すだけになる

**対応（`aidd-phase1-router.js`）**: changedFilesが1件以上あり、かつ**全件**が
`.claude/workflows/`・`.claude/agents/`・`docs/agents/`のいずれか配下の場合のみ、
既存のキーワード一致・パス一致判定（上記の高リスクパス判定）より**先に**「メタ改修」と
確定させ、Sweepを一切実行しない専用の軽量ルートへ振り分ける。この条件を満たさない限り
（1件でもプロダクトコードが混在する、あるいはchangedFiles自体が空の場合）、この分岐は
一切発火せず、既存のTRI/RISK判定（プロダクトコード向け）はそのまま適用される。「メタ改修
パスが先に判定される」ことと「既存の高リスクパス判定を緩めない」ことは独立した設計であり、
どちらもこの優先順位によって両立している。設計判断の詳細は
[`decisions/aidd-pipeline.md`](./decisions/aidd-pipeline.md#なぜメタ改修判定をキーワードマッチより先に評価することにしたかissue-457)を参照。

正本は`.claude/workflows/lib/router-risk.js`（`classifyRoute`）、`aidd-phase1-router.js`側の
インライン複製との同期は`.claude/workflows/lib/__tests__/router-risk-sync.test.js`が検証する
（`npm test`に含まれる。他のプロンプト同期テストと同型のガード）。

## テスト環境・データ衛生ルール

`e2e/`配下のファイルをRead/Editする際にのみ [`.claude/rules/e2e-test-hygiene.md`](../../.claude/rules/e2e-test-hygiene.md) が自動ロードされる（issue #445）。

## DBスキーマ変更ルール

`supabase/migrations/`配下のファイルをRead/Editする際にのみ [`.claude/rules/db-schema.md`](../../.claude/rules/db-schema.md) が自動ロードされる（issue #445。path-scoped rules化により、DB作業をしないセッションでは常時のコンテキストコストを払わない）。

## ブランチ運用ルール

- **新しいissue・機能の作業を始める前に、現在のブランチが別issue用の未マージPRの対象になっていないか確認する**（`git branch --show-current` → `gh pr list --head <branch>`）。
  なっていた場合は、着手前に `git checkout -b <new-branch> main` で新しいブランチを切ってから進める。
  1つのPRに無関係なissueのコミットが混ざると、レビュアーが混乱し、片方だけ却下・差し戻しになった際に切り分けられなくなる
  - **このルールのうち「現在のブランチに既にマージ済みのPRが乗っている」ケースは、SessionStart hook（`scripts/check-branch-pr-status.sh`）が機械的に警告する。**
    `git branch --show-current` → `gh pr list --head <branch> --state merged` の結果が空でなければ、セッション開始時に警告メッセージを出す（block不可・warningのみ）。
    実際にissue-20-orders-list-page等、マージ済みブランチ上で気づかず並行作業が続き、重複・陳腐化したworktreeが複数残った実害があったため導入した。
    **「別issueの未マージPRが乗っている」ケース（マージ前の分岐）はこのhookの検知対象外**で、引き続き人手の確認に依存する。
- **`git checkout -b <new-branch> main` の前に、必ず `git fetch origin main` してから最新の `origin/main` を起点にする**（`git checkout -b <new-branch> origin/main`、または直前に`git merge origin/main`でローカルmainを追従させる）。
  ローカルの`main`ブランチ参照は自動更新されない（`gh pr merge`はリモートを更新するだけで、ローカルの別ブランチにいる間はローカル`main`が古いまま）。古いローカル`main`から新しいブランチを切ると、直近でマージされたPRの変更が丸ごと欠落した状態で作業が進んでしまい、後から気づいて`origin/main`をマージし直す手戻りが発生する
  - **このルールは、SessionStart hook（`scripts/check-local-main-freshness.sh`、issue #499）が部分的に機械検知する。**
    FETCH_HEADの更新時刻が既定24時間（`LOCAL_MAIN_STALE_HOURS`で変更可）より古いか、`git rev-list --count main..origin/main`が1以上（ローカルmainがorigin/mainより遅れている）のいずれかに該当すると、セッション開始時に警告メッセージを出す（block不可・warningのみ、fetch自体はhook内で実行しないためネットワークアクセス無し・オフラインでも動作する）。
    worktree環境では`.git`がファイルでありFETCH_HEADの実体がworktree固有パスにあるため、`git rev-parse --git-path FETCH_HEAD`で実パスを解決している（`.git/FETCH_HEAD`と決め打ちすると存在しないパスを見て誤判定する）。
    **これは近似判定であり、実際にリモートで何が起きているかまでは見ていない**（前回fetch時点の情報を基準にするため、fetch直後に他者がpushした場合は検知できない）。
- **新しいworktreeを手動で作る場合は`git worktree add`を直接叩かず`scripts/create-worktree.sh <branch-name> [base-branch]`を使う**（issue発生源: supabase-env-config-325893セッション）。
  `git worktree`はgit管理外ファイル（`.env.local`・`.env.test`等、`.gitignore`対象）を新規worktreeへ引き継がないため、素の`git worktree add`だけで作ると`NEXT_PUBLIC_SUPABASE_URL`等が欠落しRuntime Errorになる。このスクリプトは`git fetch origin main`→`origin/main`起点でのbranch作成（上記ルール）と`.env.local`/`.env.test`の自動コピーをまとめて行う。
  **既知の限界**: Claude Code本体のEnterWorktreeツール経由でworktreeを作った場合はこのスクリプトを経由しないため、同じ欠落が起きうる（ツール内部の挙動でありこのリポジトリ側からは制御できない）。その場合は引き続き手動で`.env.local`/`.env.test`をコピーする必要がある

## loop-observabilityログの記録漏れ検知

AIDDフロー（`aidd-phase2.js` 等）は reviewer/implementer/judge-panel の呼び出しごとに記録を残す想定だが、これはエージェントへの自然言語指示に依存しており強制力がない（背景・既知の限界は [`observability-internals.md`](./observability-internals.md#loop-observability記録漏れ検知の背景と既知の限界) 参照）。

**AIDDフロー（Phase 2以降）を実行する前後で、必ず以下を行うこと（issue #488でStop hook自動実行化済み）。**
1. フロー開始時（Phase 1前に1回）に `scripts/record-gap-check-state.sh before` を実行する
   （件数の計測・記録はスクリプトが行う。手動のwc -l/jq計測は不要になった）
2. 各フェーズ完了後、戻り値の `stats.expectedLoopObservabilityRecords` /
   `stats.expectedAgentProgressRecords` をその都度記録する（加算方式のため、フェーズごとに
   順に呼べば合算される。無い方の引数は省略する）:
   ```bash
   # phase1完了後（expectedAgentProgressRecordsのみ返るフェーズの例）
   scripts/record-gap-check-state.sh expected --agent-progress 4
   # phase2完了後（両方返るフェーズの例）
   scripts/record-gap-check-state.sh expected --loop-observability 10 --agent-progress 12
   ```
3. gap check本体はStop hook（`scripts/check-gap-check-state.sh`）がターン終了時に自動実行し、
   `hasGap: true` ならsystemMessageで警告する（実行後にstateファイルは自動クリアされる）。
   手動での `scripts/check-loop-observability-gap.sh --before N --expected M` 実行は
   再検証したい場合のみでよい
4. 警告が出た場合、記録漏れとして扱い、issue化するか原因を調査する

既知の限界: stateファイルへの記録（上記1・2）自体は依然オーケストレーターの自己申告のまま（詳細は前掲の観測インフラ内部詳細を参照）。

## サブエージェント進捗の可視化（issue #18）

サブエージェント（sweep-db/sweep-ui/sweep-types/sweep-data/implementer/reviewer/integrator/
judge-panel/proposer/adversarial-verify/completeness-critic/contract-writer）は、
作業の**開始時**と**終了時**（成功・失敗いずれも）に `scripts/log-agent-progress.sh` を呼び、
`logs/agent-progress.jsonl` に進捗を記録すること。
```
scripts/log-agent-progress.sh --agent "<自分のagent名>" --feature "<feature名>" \
  --status running --note "<今やっていることの短い説明>"
# ...作業...
scripts/log-agent-progress.sh --agent "<自分のagent名>" --feature "<feature名>" \
  --status done --note "<完了内容の短い説明>"    # 失敗時は --status failed
```
`--status` は `starting|running|waiting|done|failed` のいずれか。`feature`名が
呼び出し元から与えられていない場合は `unknown` を使う。

現在の状態は `scripts/show-agent-status.sh` で一覧できる（`--stale-seconds`未満は既定180秒＝3分。`running`/`waiting`のまま既定180秒以上更新がないエージェントは「止まってる？」として表示される）。

記録漏れ検知の手順はloop-observabilityと共通のgap check state方式（上記[「loop-observabilityログの記録漏れ検知」](#loop-observabilityログの記録漏れ検知)参照。フロー完了後に `scripts/record-gap-check-state.sh expected --agent-progress <値>` を呼ぶ）。記録内容の正しさは `scripts/verify-agent-progress-transcript.sh` が自己申告とtranscriptを機械比較する。両者の判定ロジック・既知の限界（agent-progress.jsonlの構造的限界、mismatches/lowOverlapDetailsの仕組み等）は [`observability-internals.md`](./observability-internals.md#agent-progress記録の構造的限界記録内容検証の詳細) を参照。

## 観測・Eval基盤の内部詳細への参照

以下の実装詳細・経緯・既知の限界は `docs/agents/common.md` 圧縮（issue #486）により [`observability-internals.md`](./observability-internals.md) へ移動した:

- サブエージェント骨格記録の機械強制（issue #423、3層の保証レベル・journal.jsonl統合）
- OpenTelemetryと自作JSONLの役割分担（issue #417、opt-in設定手順）
- statuslineでcontext・コスト・レート制限を可視化（issue #446、opt-in設定手順）
- agents設定変更時のbaselineスナップショット機械強制（issue #429）
- Find→Adversarial Verify precision記録（issue #432）
- Sweep recallベンチマーク（issue #431）
- AIDDワークフロープロンプトのeval（issue #391）— 運用ルール（義務化、issue #496）は`.claude/workflows/`配下のファイルをRead/Editする際に [`.claude/rules/workflow-eval-requirement.md`](../../.claude/rules/workflow-eval-requirement.md) として自動ロードされる（issue #445）

## ツール・機能導入可否の判断記録への参照

以下の実機検証結果・見送り理由は `docs/agents/common.md` 圧縮（issue #486）により [`tooling-decisions.md`](./tooling-decisions.md) へ移動した:

- Bashサンドボックス機能は現行toolchainと非互換のため保留（issue #438）
- Channelsは今回のユースケースに不向きなため見送り（issue #448）
- claude-code-actionは費用対効果の観点で見送り（issue #447）
- security-guidanceプラグインでknown-failure-patterns.mdを機械検知化（issue #440）
- blockedラベルの再開条件見直しはSessionStart hookで機械ポーリング（issue #453）
- 定期実行の機械トリガー化はSessionStart hookに一本化、OS launchdは見送り（issue #443）
- autoMode(hard_deny)は個人設定のみ有効・設定し忘れ検知はSessionStart hookで（issue #439）

## 引き継ぎフォーマット

「できました」で終わる完了報告は禁止。作業完了時（PR本文・セッション終了報告・
`docs/sessions/` への記録のいずれか）は、`handoff-format`スキル（[`../../.claude/skills/handoff-format/SKILL.md`](../../.claude/skills/handoff-format/SKILL.md)）のフォーマットで
引き継ぎメモを残す（issue #542。タスク完了時のみ必要なため常時ロードから外しスキル化した）。
このフォーマットはissue #666で、後任AI向けの観点に加え、人間レビュアーが「何が変わり、
危険度はどれくらいで、どこを見ればよいか」を短時間で判断できる「30秒サマリー」＋
00〜05の証拠パッケージ構成に刷新した。PR本文経由での引き継ぎ（`gh pr create`/`gh pr edit`）は、
Stop hook（`scripts/check-handoff-format.sh`、issue #524／新フォーマットへの追従は
issue #666）が「30秒サマリー」「どう確認したか」の見出しの有無を機械検知し、無ければ警告する
（PRにつき1回・warningのみ。セッション終了報告・`docs/sessions/`経由の引き継ぎは検知対象外）。

## 検知手段のないルールの棚卸し（issue #339）

新しい運用ルールを書く前は必ず[`decisions.md`の該当原則](./decisions.md#なぜ新しい運用ルールに検知手段を先に決める原則を導入したかissue-339)を先に読むこと。
特に、新しい検知・検証メカニズム自体を追加する際は「その起動トリガーは機械（hook/CI/cron/npm test）
か人か」を先に確認すること（issue #411）。「破られても機械的に気づく手段がない」ルール（第3層）の
一覧は [`undetectable-rules-inventory.md`](./undetectable-rules-inventory.md) を参照（issue #542で
参照頻度の低い棚卸し表として本ファイルから分離）。

## fault injection訓練の実施タイミング（issue #395）

`.claude/workflows/aidd-phase2.js`のSpec Check/Manifest Check関連のプロンプトを変更したとき、
および四半期に1回の定期訓練として、実際のWorkflow実行を通じてdeny-by-defaultゲート
（Spec Check・Manifest Check）が本当に`blocked`を返すことを実測する。手順・4シナリオの期待値・
実施記録欄は[`fault-injection-drill.md`](./fault-injection-drill.md)を参照。

背景: `aidd-phase2.js`のゲート判定は実際にはエージェントへの自然言語プロンプト指示として実行
されており、`.claude/workflows/lib/`配下の純粋関数ミラーとそのテストはプロンプト文言の変更に
自動追従しない（issue #348で発覚した回避穴と同種のギャップ）。単体テストのgreenだけでは
「実行パスの本体が本当にblockedを返すこと」は証明されないため、実測訓練で埋める。

## ツール制約回避のload-bearing workaround棚卸し（issue #413）

AIDDフレームワークの相当部分がツール（Workflow DSL / `claude -p`）の制約・不具合への回避策で
できている。ツール本体を更新したとき、またはeval/ワークフロー実行が理由不明に失敗し始めた
ときは、[`load-bearing-workarounds.md`](./load-bearing-workarounds.md) を参照すること
（issue #542で参照頻度の低い棚卸し表として本ファイルから分離）。

## 重要ファイルへのパス

| ファイル | 目的 |
|---|---|
| [`docs/agents/common.md`](./common.md) | 全AIエージェント共通ルール（本ファイル）・引き継ぎフォーマット |
| [`docs/agents/observability-internals.md`](./observability-internals.md) | 観測・Eval基盤の実装詳細・既知の限界（common.mdから分離、issue #486） |
| [`docs/agents/tooling-decisions.md`](./tooling-decisions.md) | 公式機能・プラグインの導入可否判断記録（common.mdから分離、issue #486） |
| [`docs/agents/actuator-inventory.md`](./actuator-inventory.md) | 検知hookの検知後の是正（block/自動復旧/warning-only）の棚卸し（issue #578） |
| [`docs/agents/portability-inventory.md`](./portability-inventory.md) | 多リポジトリ展開に向けたドメイン非依存/スタック依存の切り分け棚卸し（issue #535） |
| `docs/ai-config-map.md` | エージェント・スキル全体マップ |
| `src/app/` | Next.js App Router のページ・API Routes |
| `src/components/` | UI コンポーネント |
| `src/lib/supabase/` | Supabase クライアント・データ取得層 |
| `supabase/migrations/` | DBマイグレーション |
| `scripts/create-worktree.sh` | worktree作成 + `.env.local`/`.env.test`自動コピー（「ブランチ運用ルール」参照） |
| [`docs/agents/run-manifest.md`](./run-manifest.md) | AIDDフローのspecHash/baseCommit突合用Run Manifestのスキーマ |
| `scripts/log-agent-progress.sh` / `scripts/show-agent-status.sh` | サブエージェント進捗の記録・一覧表示（issue #18） |
| `scripts/lib/resolve-log-dir.sh` | `logs/`の書き込み先をworktree横断で単一のディレクトリ（メインworktree直下）に解決する。全`log-*.sh`/`check-*.sh`/`summarize-*.sh`が参照する（issue #546。従来は各worktreeが起動時のカレントディレクトリ相対で別々の`logs/`に書き込み、観測記録の約半数が死蔵していた） |
| `scripts/lib/canonical-event.ts` | hook/journal/agent-progress/loop-observabilityの4ログを正規化する読み取り専用Adapter層（issue #569） |
| `scripts/summarize-gate-blocked.sh` / `scripts/lib/gate-effectiveness-summary.ts` | journal.jsonlのblocked状態をagentType別に集計し月次品質ゲートサマリへ追記（issue #569残タスク） |
| `scripts/check-agent-progress-gap.sh` | agent-progress記録漏れの機械検知（issue #339） |
| `scripts/record-gap-check-state.sh` | gap check用before/expected件数の記録（issue #488。オーケストレーター専用） |
| `scripts/check-gap-check-state.sh` | Stop hookによるgap checkの自動実行（issue #488） |
| `scripts/check-aidd-stats-recorded.sh` | Stop hookによるAIDD stats start呼び忘れの機械検知（issue #495） |
| `scripts/check-aidd-phase-stats-recorded.sh` | Stop hookによるAIDD stats phase1/phase2呼び忘れの機械検知（issue #524） |
| `scripts/check-handoff-format.sh` | Stop hookによるPR本文の引き継ぎフォーマット必須見出し欠如の機械検知（issue #524） |
| `scripts/check-find-av-precision-recorded.sh` | Stop hookによるfind-av-precisionログ記録漏れの機械検知（issue #522） |
| [`docs/agents/recovery-queue.md`](./recovery-queue.md) | 検知後の自動復旧閉ループの設計・スコープ・既知の未対応（issue #523） |
| `scripts/queue-recovery-task.sh` | 検知hookから呼ばれ`.aidd/recovery-queue.jsonl`へ復旧タスクを登録する（issue #523） |
| `scripts/check-recovery-queue.sh` | SessionStart hookによる未対応の復旧タスクのcontext注入・surfaced放置エントリのエスカレーション（issue #523・#579） |
| `scripts/resolve-recovery-task.sh` | 復旧タスク対応後に`status`を`"resolved"`へ書き換える（issue #579） |
| `scripts/check-workflow-interruption.sh` | SessionStart hookによるWorkflow中断検知(`wf_*.json`のstatus/staleness判定)とrecovery-queueへの登録（issue #534） |
| [`docs/agents/fault-injection-drill.md`](./fault-injection-drill.md) | `aidd-phase2.js`のdeny-by-defaultゲート実測訓練のランブック（issue #395） |
| `scripts/aidd-fault-injection-setup.sh` / `scripts/aidd-fault-injection-teardown.sh` | fault injection訓練用の`.aidd/run-manifest.json`差し替え・復元（issue #395） |
| `scripts/eval-workflow-prompts.sh` / `scripts/eval-fixtures/` | AIDDワークフロープロンプトのeval基盤（issue #391） |
| `.claude/workflows/lib/prompts/` | ワークフロー内プロンプト文字列の正本（Workflow DSL側へはインライン複製、sync testで乖離検知） |
| `.claude/workflows/lib/budget-guard.js` | Loop Until Dryへのbudgetガード判定ロジックの正本（issue #442） |
| [`docs/agents/workflow-resume-runbook.md`](./workflow-resume-runbook.md) | Workflow実行が中断した際の`resumeFromRunId`再開手順（issue #442） |
