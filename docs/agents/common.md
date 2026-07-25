# 共通ルール（全AIエージェント共通）

このファイルは Claude Code・Codex 等、このリポジトリで作業するすべての AI エージェントが
従うべき共通ルールを定義する。ツール固有の設定（サブエージェント・スキル・ワークフロー・
開発フローのオーケストレーション等）は各ツールの入口ファイル（`CLAUDE.md` / `AGENTS.md`）
側を参照すること。

- ドメイン用語（facility・price等が何であるか）は [`domain.md`](./domain.md) を参照
- 各ルールが「なぜ」その設計になったかは [`decisions.md`](./decisions.md) を参照
- 過去に実際に再発した実装ミスのチェックリストは [`known-failure-patterns.md`](./known-failure-patterns.md) を参照（レビュー・Sweep系エージェントは必読）
- 検知手段のないルール（自然言語のみで強制力の無いルール）の一覧は [「検知手段のないルールの棚卸し（issue #339）」](#検知手段のないルールの棚卸しissue-339) を参照

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

- **E2E/BSGはテスト専用Supabaseのみに接続する。** 接続情報は `.env.test` に置く（`.env.test.example` 参照）。
  `NODE_ENV=test` のため `.env.local`（本番）は読み込まれず、さらに `e2e/env-guard.ts` が
  許可ホスト以外（＝本番URL・本番service role実行）を**即失敗**させる
- **認証ファイル（`e2e/.auth/user.json`）の漏洩チェックはCI側で行う**（`.github/workflows/e2e.yml`）。
  BSG（ローカルゲート）ではチェックしない方針
- **seed・スクリーンショット・E2E失敗ログ・issue添付に実在施設名・実データを入れない。**
  施設名・ユーザー名・在庫品目などはすべてダミー（例: `テスト施設A`、`e2e-test-user@example.com`）を使う

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
- AIDDワークフロープロンプトのeval（issue #391）— **運用ルール（義務化、issue #496）だけは下記に残す**: `.claude/workflows/*.js` のプロンプト文言を変更したPRでは、マージ前に `npm run eval:workflows <対応するfixtureセット>`（sweep系のプロンプト変更は `scripts/eval-sweep-recall.sh <layer>`）を実行し、結果を引き継ぎメモの「検証済み」欄へ記載すること（未実施の場合はその旨と理由を明記する）。実行完了時に `docs/agents/eval-runs.jsonl` へ自動記録され、未更新のPRは `.github/workflows/eval-runs-freshness-check.yml` が警告する。

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
`docs/sessions/` への記録のいずれか）は、以下のフォーマットで引き継ぎメモを残す。
確認範囲がAIごとにブレる問題・後任AIがスコープ外を「重大な見落とし」と誤認する問題を防ぐ。

```
## 作業サマリ
- 変更した目的:
- 変更した範囲:
- 触っていない範囲:

## 検証済み
- 実行したコマンド:（`npm run ai:check` の実行有無を含む）
- 確認した画面:
- 確認したDB/RLS:
- 他テナントのIDでアクセスし、弾かれることを確認したか:（RLS/facility境界に触れた場合は必須）

## 既知の未対応
- 今回あえて対応しなかったこと:
- 理由:
- 次に触るなら見る場所:

## 後任AIへの注意
- この実装で壊してはいけない前提:
- 似ているが別物の用語:
- 勝手にリファクタしない場所:
```

- auth/facility/tenant/organization/inventory/RLS/policy に触れた変更は、「検証済み」の
  他テナントIDアクセス確認を省略しない（Issue #24再発防止。チェック観点は
  [`known-failure-patterns.md`](./known-failure-patterns.md) 参照）
- PR本文経由での引き継ぎ（`gh pr create`/`gh pr edit`）は、Stop hook
  （`scripts/check-handoff-format.sh`、issue #524）が「## 作業サマリ」「## 検証済み」の
  2見出しの有無を機械検知し、無ければ警告する（PRにつき1回・warningのみ。セッション終了報告・
  `docs/sessions/`経由の引き継ぎは検知対象外）

## 検知手段のないルールの棚卸し（issue #339）

新しい運用ルールを書く前は必ず[`decisions.md`の該当原則](./decisions.md#なぜ新しい運用ルールに検知手段を先に決める原則を導入したかissue-339)を先に読むこと。
特に、新しい検知・検証メカニズム自体を追加する際は「その起動トリガーは機械（hook/CI/cron/npm test）
か人か」を先に確認すること（issue #411）。人起動なら第3層ルールの削減ではなく追加になるだけで、
下記棚卸し表に行が1つ増えて終わる。
以下は2026-07-14時点で「破られても機械的に気づく手段がない」ルールの一覧（第3層）。
検知手段を実装したら、このルールの説明に検知手段へのリンクを追記してこの表から外すこと。

| ルール | 所在 | 備考 |
|---|---|---|
| ブランチ運用ルール（`origin/main`起点でのbranch作成） | 本ファイル「ブランチ運用ルール」 | 過去に古いローカル`main`起点でbranch作成し手戻りが発生した実績あり。着手前PR確認のうち「マージ済みPRが乗っている」ケースは`scripts/check-branch-pr-status.sh`（SessionStart hook）で検知済み。**`origin/main`起点確認自体もissue #499で部分検知済み**（`scripts/check-local-main-freshness.sh`。FETCH_HEAD鮮度・ローカルmainの遅れコミット数による近似判定、fetchはhook内で実行しないため取りこぼしうる）。「別issueの未マージPRが乗っている」ケース（マージ前の分岐）は引き続き未検知のまま |
| サーキットブレーカー（`/goal`設定・テスト修正3回まで・フロー全体上限） | ルートの`CLAUDE.md` | issue #441で検知手段を調査したが、「`/goal`が設定されているか」を外部から機械的に問い合わせるAPI/hookは公式に存在しないと判明（実機確認済み）。条件テンプレート化・役割分担の明文化（Workflow内部retryとの切り分け）は完了したが、呼び忘れ自体の検知は依然できないままこの表に残る |
| 停止①②以外で止まらず自律進行すること | ルートの`CLAUDE.md`「絶対ルール」 | |
| gap check stateの記録（`record-gap-check-state.sh` before/expectedの呼び出し） | ルートの`CLAUDE.md`「gap check state 記録ルール」 | gap check本体の実行はissue #488でStop hookに機械化済み。ただしこの記録呼び出し自体の呼び忘れ検知は無い（Workflow DSLがfilesystem API不可のため自己申告依存が残る。AIDD statsのphase単位呼び出しと同型の限界だったが、そちらはissue #524で検知済みになった） |
| seed・スクリーンショットに実在施設名を使わない | 本ファイル「テスト環境・データ衛生ルール」 | per-edit層で部分検知（`.claude/security-patterns.json`の`possible_real_facility_name`、issue #440）。ただし`/plugin install security-guidance@claude-plugins-official`の実機有効性は未確認、かつスクリーンショット・issue添付・E2E失敗ログは検知対象外 |
| `aidd-phase2.js`のSpec Check/Manifest Check関連プロンプトを変更した際のfault injection訓練の実施自体 | 本ファイル「fault injection訓練の実施タイミング（issue #395）」 | 訓練の手順・fixture・setup/teardownスクリプトは用意した（[`fault-injection-drill.md`](./fault-injection-drill.md)）が、「変更時に必ず訓練を実施すること」自体を機械的に強制する手段（例: 該当プロンプト変更を検知してブロックするpre-commit等）は無い。実施記録の記入漏れにも気づく仕組みが無い |

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

2026-07-16のmentor設計レビューで、AIDDフレームワークの相当部分がツール（Workflow DSL /
`claude -p`）の制約・不具合への回避策でできていることが確認された。各回避策はdecisions.md等に
「なぜ」が記録されガードも付いているが、**Claude Code側の更新で回避策の前提が壊れると、検知網
自体が静かに全滅しうる**（回避策 = 検知網の土台、というメタ構造のため）。ツール本体を更新した
とき、またはeval/ワークフロー実行が理由不明に失敗し始めたときは、まずこの表を確認すること。

| 回避策 | 場所 | 前提とするツール挙動 | 解除条件／破損条件 | smoke test |
|---|---|---|---|---|
| args `typeof === 'string'` → `JSON.parse`防御 | `.claude/workflows/aidd-phase1-router.js`（正本: `.claude/workflows/lib/resolve-workflow-args.js`） | Workflowツールがargsをobjectで渡してもstringで届く不具合（[`decisions/aidd-pipeline.md`](./decisions/aidd-pipeline.md#なぜaidd-phase1-routerjsでargsをjsonparseする防御コードを入れたか)） | **解除**: ツール側がargsを常にobjectで渡すよう修正されれば、この分岐に到達しなくなるだけで副作用なし（前方互換設計のため削除は任意）。**破損**: このガード自体が壊れることは想定しにくい（`typeof`判定のみのため） | `resolve-workflow-args.test.js`（npm test内） |
| `--setting-sources ""` + `--agents`フラグでのagent定義注入 | `scripts/lib/build-eval-agent-json.mjs` | `--setting-sources ""`が`.claude/agents/*.md`探索も無効化する挙動 | **解除**: `--setting-sources`が`.claude/agents/`探索のみを無効化しないよう修正されれば不要。**破損**: `--agents`フラグのJSON構造・優先順位が変更されると`--agent implementer`解決自体が失敗し、evalの実エージェント呼び出しが全滅する（[`observability-internals.md`](./observability-internals.md#aiddワークフロープロンプトのevalissue-391)「AIDDワークフロープロンプトのeval」に既述のload-bearing箇所） | JSON出力形式は`build-eval-agent-json.test.mjs`（npm test内）で検証済み。**ただし実際に`claude -p --agents ... --agent <type>`でagent解決できるかどうかの専用smoke testは無い**（`claude -p`の実呼び出しが必要でCI化見送り済みのため、issue #391と同じ判断。`npm run eval:workflows db-impl`を手動実行した際に暗黙的に再検証されるのみ） |
| プロンプト正本の切り出し＋インライン複製＋sync test | `.claude/workflows/lib/prompts/db-impl.js` ⇔ `aidd-phase2.js`、`.claude/workflows/lib/spec-check.js` / `manifest-check.js` ⇔ `aidd-phase2.js`、`.claude/workflows/lib/prompts/sweep.js` ⇔ `aidd-phase1.js` / `aidd-1-1-deep-task.js` | Workflow DSLがfilesystem API不可でローカルモジュールをrequire/importできない制約 | **解除**: Workflow DSLがローカルモジュールをimportできるようになれば、インライン複製自体が不要になり正本を直接importする形に変えられる。**破損**: プロンプト文言変更時にインライン複製側を追従させ忘れると乖離する（これを検知するのがsync testの目的そのもの） | `workflow-prompt-sync.test.js` / `sweep-prompt-sync.test.js`（npm test内） |
| TRI/RISK・メタ改修判定ロジックの切り出し＋インライン複製＋sync test | `.claude/workflows/lib/router-risk.js` ⇔ `aidd-phase1-router.js`（issue #457） | 同上（Workflow DSL importの制約）。プロンプト（テンプレートリテラル）ではなく`const`配列・`function`宣言の複製のため、`extract-declaration.js`という別の抽出ユーティリティを使う | **解除**: 同上。**破損**: `classifyRoute`等の関数・定数配列を変更したのに`aidd-phase1-router.js`側のインライン複製を追従させ忘れると乖離する | `router-risk-sync.test.js`（npm test内） |
| eval fixture manifestとaidd-phase2.js内スキーマ定義の同期 | `scripts/eval-fixtures/db-impl/manifest.json` ⇔ `aidd-phase2.js`内のスキーマ定義 | 同上（Workflow DSL importの制約） | **解除**: 同上。**破損**: スキーマ定義がドリフトすると、evalが実際のプロンプトと異なるスキーマでテストしてしまい気づかれない | `eval-fixture-manifest-schema-sync.test.js`（npm test内） |
| 進捗・観測ログの自然言語指示依存 | `scripts/log-agent-progress.sh` / `scripts/log-loop-observability.sh`呼び出し | Workflow DSLがfilesystem API不可で、ワークフロー本体から機械的にログを書き込めない制約 | **解除**: 同上（importまたは直接fs書き込みが可能になれば、本体側から機械的に記録できる設計に変更可能）。**破損**: 元々「壊れる」ものではなく「そもそも書かれない」リスクが常態（自然言語指示依存のため） | 記録漏れの事後検知（`check-loop-observability-gap.sh` / `check-agent-progress-gap.sh`）があり、その実行はStop hook（`scripts/check-gap-check-state.sh`、issue #488）で機械トリガー化済み。ただしbefore/expectedのstateファイル記録（`scripts/record-gap-check-state.sh`）自体はオーケストレーターの自己申告のまま残る |

**Claude Code更新時の確認手順**: (1) 上表の「smoke test」列にnpm test内のテストがある項目は
`npm test`を実行して確認する。(2) smoke testが「無い」と明記されている項目（現状は
`--setting-sources`+`--agents`の組み合わせのみ）は`npm run eval:workflows db-impl`を一度手動実行し、
4ケース中`case-1`〜`case-4`がエージェント呼び出し自体（`NG: エージェント実行が失敗しました`
以外の結果）に到達しているかを確認する。(3) 新しいload-bearing workaroundを追加した場合は、
この表に行を追加すること（issue #411の原則どおり、smoke testを機械トリガーに載せられないなら
その旨をこの表に明記し、prose追加だけで済ませない）。

## 重要ファイルへのパス

| ファイル | 目的 |
|---|---|
| [`docs/agents/common.md`](./common.md) | 全AIエージェント共通ルール（本ファイル）・引き継ぎフォーマット |
| [`docs/agents/observability-internals.md`](./observability-internals.md) | 観測・Eval基盤の実装詳細・既知の限界（common.mdから分離、issue #486） |
| [`docs/agents/tooling-decisions.md`](./tooling-decisions.md) | 公式機能・プラグインの導入可否判断記録（common.mdから分離、issue #486） |
| `docs/ai-config-map.md` | エージェント・スキル全体マップ |
| `src/app/` | Next.js App Router のページ・API Routes |
| `src/components/` | UI コンポーネント |
| `src/lib/supabase/` | Supabase クライアント・データ取得層 |
| `supabase/migrations/` | DBマイグレーション |
| `scripts/create-worktree.sh` | worktree作成 + `.env.local`/`.env.test`自動コピー（「ブランチ運用ルール」参照） |
| [`docs/agents/run-manifest.md`](./run-manifest.md) | AIDDフローのspecHash/baseCommit突合用Run Manifestのスキーマ |
| `scripts/log-agent-progress.sh` / `scripts/show-agent-status.sh` | サブエージェント進捗の記録・一覧表示（issue #18） |
| `scripts/check-agent-progress-gap.sh` | agent-progress記録漏れの機械検知（issue #339） |
| `scripts/record-gap-check-state.sh` | gap check用before/expected件数の記録（issue #488。オーケストレーター専用） |
| `scripts/check-gap-check-state.sh` | Stop hookによるgap checkの自動実行（issue #488） |
| `scripts/check-aidd-stats-recorded.sh` | Stop hookによるAIDD stats start呼び忘れの機械検知（issue #495） |
| `scripts/check-aidd-phase-stats-recorded.sh` | Stop hookによるAIDD stats phase1/phase2呼び忘れの機械検知（issue #524） |
| `scripts/check-handoff-format.sh` | Stop hookによるPR本文の引き継ぎフォーマット必須見出し欠如の機械検知（issue #524） |
| `scripts/check-find-av-precision-recorded.sh` | Stop hookによるfind-av-precisionログ記録漏れの機械検知（issue #522） |
| [`docs/agents/recovery-queue.md`](./recovery-queue.md) | 検知後の自動復旧閉ループの設計・スコープ・既知の未対応（issue #523） |
| `scripts/queue-recovery-task.sh` | 検知hookから呼ばれ`.aidd/recovery-queue.jsonl`へ復旧タスクを登録する（issue #523） |
| `scripts/check-recovery-queue.sh` | SessionStart hookによる未対応の復旧タスクのcontext注入（issue #523） |
| [`docs/agents/fault-injection-drill.md`](./fault-injection-drill.md) | `aidd-phase2.js`のdeny-by-defaultゲート実測訓練のランブック（issue #395） |
| `scripts/aidd-fault-injection-setup.sh` / `scripts/aidd-fault-injection-teardown.sh` | fault injection訓練用の`.aidd/run-manifest.json`差し替え・復元（issue #395） |
| `scripts/eval-workflow-prompts.sh` / `scripts/eval-fixtures/` | AIDDワークフロープロンプトのeval基盤（issue #391） |
| `.claude/workflows/lib/prompts/` | ワークフロー内プロンプト文字列の正本（Workflow DSL側へはインライン複製、sync testで乖離検知） |
| `.claude/workflows/lib/budget-guard.js` | Loop Until Dryへのbudgetガード判定ロジックの正本（issue #442） |
| [`docs/agents/workflow-resume-runbook.md`](./workflow-resume-runbook.md) | Workflow実行が中断した際の`resumeFromRunId`再開手順（issue #442） |
