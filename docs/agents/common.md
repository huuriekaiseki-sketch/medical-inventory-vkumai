# 共通ルール（全AIエージェント共通）

Claude Code・Codex 等、このリポジトリで作業するすべての AI エージェントが従う共通ルール。
**ここには「何をすべきか」だけを置く。** 「なぜそうなったか」「hook の実装詳細」「どこに何があるか」は
下記の分離先にあり、必要になったときに読む（常時ロードの総量を空けるため。2026-09-07）。

| 分野 | いつ読むか |
| --- | --- |
| [作業を始める前に](#作業を始める前に) | 着手時。レーン判定とブランチ |
| [変えるときの手順](#変えるときの手順) | 依存・DB・e2e を触るとき |
| [AIDD フロー実行中の記録](#aidd-フロー実行中の記録) | フローを回すとき |
| [終わり方](#終わり方) | 作業完了時 |
| [ルール・仕組みを増やす前に](#ルール仕組みを増やす前に) | 新しいルール・検知を作るとき |
| [どこに何があるか](#どこに何があるか) | 何かを作る前に「既にあるか」を確かめるとき |

**分離先**（本ファイルからは常時ロードされない。読みに行く）:

- [`file-index.md`](./file-index.md) — 重要なファイル・スクリプトと目的の索引
- [`decisions.md`](./decisions.md) — 各ルールが**なぜ**その設計になったか
- [`domain.md`](./domain.md) — ドメイン用語（facility・price 等が何であるか）
- [`known-failure-patterns.md`](./known-failure-patterns.md) — 過去に**実際に再発した**実装ミスのチェックリスト（レビュー・Sweep 系エージェントは必読）
- [`undetectable-rules-inventory.md`](./undetectable-rules-inventory.md) — 破られても機械で気づけないルールの一覧
- [`actuator-inventory.md`](./actuator-inventory.md) — 検知 hook の是正（block / 自動復旧 / warning-only）の一覧
- [`parallel-agent-work.md`](./parallel-agent-work.md) — Claude Code / Codex 並行作業（同一 worktree 同時作業の禁止・状態ファイルの分離）
- [`claude-codex-coexistence-template.md`](./claude-codex-coexistence-template.md) — 上記のリポジトリ非依存版

## 作業を始める前に

どのレーンで進めるか・どのブランチで進めるかを決める。ここを外すと後から全部やり直しになる。

### TRI/RISK 機械判定基準（AIDDパイプライン採用条件）

変更が以下の**いずれか**に触れる場合、Sレーン（軽量レーン）は禁止。必ず M/L 扱いとし、RISK=はい と判定する：

- `supabase/migrations/` 配下のファイル
- `src/lib/supabase/` 配下のファイル
- **認可の判断が書かれているファイル**（`stryker.config.json` の `mutate` と同じ集合。issue R02）：
  `src/lib/security/` 配下 / `src/lib/audit/` 配下 / `src/app/api/admin/` 配下 /
  パスが src/lib/admin- で始まるファイル（`src/lib/admin-auth.ts` など） /
  `src/lib/api-error.ts` / `src/lib/api-pagination.ts` /
  `src/lib/invariant-error.ts` / `src/lib/log-safe.ts`
- `middleware.ts` / `proxy.ts`（プロジェクト内のすべてのmiddleware/proxy。proxy.tsはNext.js 16でmiddleware.tsから改名された同一ファイル規約。issue #681）
- パス・ファイル名・変更内容が以下のドメインに関わるファイル：
  **auth / facility / tenant / organization / inventory / RLS / policy**

この判定は人間の裁量で緩めない（機械判定）。迷ったら高リスク側に倒す。

**説明と変更ファイルが食い違うときは確認ルートへ**（issue R02）: `changedFiles` に高リスクパスが
1 件も無いのに `taskDescription` が上のドメイン語に当たる場合、`aidd-phase1-router` は
`light` でも `deep` でもなく `confirm`（人間の確認待ち）を返す。説明が正しければ認可の実ファイルが
一覧から漏れており、一覧が正しければ説明が実態と合っていない。どちらも黙って軽量で流してはいけない。
理由は [`decisions/aidd-pipeline.md`](./decisions/aidd-pipeline.md#なぜtririsk判定を機械判定にし人の裁量で緩めないことにしたか) を参照。

`aidd-phase1-router`を経由せず直接実装に入った場合の検知（issue #444）: 上記の高リスクパスへの
Write/Edit/MultiEdit時に`.aidd/run-manifest.json`が存在しなければ、PreToolUse hook
（`scripts/check-run-manifest-presence.sh`）がブロックせず警告のみ注入する。ブロックしない
理由・鮮度判定を見送った理由は同スクリプトのコメント、経緯は
[`decisions/aidd-pipeline.md`](./decisions/aidd-pipeline.md#なぜissue-444のpretooluse-hookを警告のみdenyの二段構えにしたか)を参照。

#### 第5カテゴリ: パイプライン自体のメタ改修（issue #457）

`.claude/workflows/`・`.claude/agents/`・`docs/agents/` 配下**のみ**を変更するタスクは、
上のキーワード・パス判定より**先に**「メタ改修」と確定し、Sweep を一切実行しない軽量ルートへ行く。
1 件でもプロダクトコードが混ざる場合と changedFiles が空の場合は発火せず、上の判定がそのまま適用される。
**この振り分けは `aidd-phase1-router.js` が自動で行う**（人が申告するものではない）。
経緯・3 つの判断・対象を広げない理由は
[`decisions/aidd-pipeline.md`](./decisions/aidd-pipeline.md#なぜメタ改修判定をキーワードマッチより先に評価することにしたかissue-457) を参照。

判定エンジンの正本は `.claude/workflows/lib/router-risk.js`（`classifyRoute`）、
リポジトリ固有の語彙（上のパス・ドメイン語）は `aidd.config.json`。
`aidd-phase1-router.js` は Workflow DSL でファイルを読めないため同じ値をインラインで持ち、
両者の一致は `.claude/workflows/lib/__tests__/` の同期テストが `npm test` で検証する。
**設定は既定値に「足す」だけで、既定値を消す手段は無い**（迷ったら高リスク側）。

### ブランチ運用ルール

- **新しい issue・機能の作業を始める前に、今のブランチが別 issue の未マージ PR の対象でないか確認する**
  （`git branch --show-current` → `gh pr list --head <branch>`）。対象なら
  `git checkout -b <new-branch> origin/main` で切り直してから進める。
- **新しいブランチは必ず `git fetch origin main` してから `origin/main` を起点にする。**
  ローカルの `main` 参照は自動更新されないので、古い `main` から切ると直近のマージが丸ごと欠落する。
- **worktree は `git worktree add` を直接叩かず `scripts/create-worktree.sh <branch> [base]` を使う。**
  素の `git worktree add` は `.env.local` / `.env.test` を引き継がず Runtime Error になる。

SessionStart hook が一部を機械検知する（`check-branch-pr-status.sh`＝マージ済みブランチ上での作業、
`check-local-main-freshness.sh`＝ローカル main の遅れ。どちらも **warning のみで止めない**）。
**検知できない範囲**（未マージ PR が乗っているケース、EnterWorktree 経由の worktree 作成、
fetch 直後に他者が push した場合）と各 hook の実装上の限界は
[`decisions.md`](./decisions.md#なぜブランチ運用ルールの機械検知を-warning-のみにし検知できない範囲を残したか) を参照。

### Next.js バージョンに関する注意

This version has breaking changes — APIs, conventions, and file structure may all differ from
your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing
any code. Heed deprecation notices.

## 変えるときの手順

触る対象ごとに、実行前に踏む手順が決まっている。

### 依存関係の変更ルール（2026-09-04）

npm パッケージの追加・更新・削除は「実行する第三者コードと依存関係を増やす設計判断」として扱う。
`npm install <pkg>` 等のパッケージ名を伴うコマンドと package.json / package-lock.json への書き込みは
PreToolUse hook（`scripts/check-dependency-change.sh`）が **ask** で止めるので、実行前に用途・代替案・
権限/環境変数/DB への影響・固定する版と出所を報告して承認を得る。実行後は引き継ぎメモ 00 欄
「依存の変更」に差分・`npm ci`・`npm audit --omit=dev --audit-level=high` の結果・ロールバックを書く
（Stop hook が記述の有無を警告する）。CI は `npm ci` のみを使い（`npm install` は構造テストで禁止）、
`dependency-audit` ジョブとロック出所の検査（`scripts/check-lockfile-integrity.test.sh`）が毎 PR で
回る。検査名ごとに分かること・分からないことは
[`known-failure-patterns.md`「依存関係層」](./known-failure-patterns.md#依存関係層npm-サプライチェーン)
を参照。

### DBスキーマ変更ルール

`supabase/migrations/`配下のファイルをRead/Editする際にのみ [`.claude/rules/db-schema.md`](../../.claude/rules/db-schema.md) が自動ロードされる（issue #445。path-scoped rules化により、DB作業をしないセッションでは常時のコンテキストコストを払わない）。

### テスト環境・データ衛生ルール

`e2e/`配下のファイルをRead/Editする際にのみ [`.claude/rules/e2e-test-hygiene.md`](../../.claude/rules/e2e-test-hygiene.md) が自動ロードされる（issue #445）。

## AIDD フロー実行中の記録

フローを回すときだけ要る。**paths 付き rules には出せない**（オーケストレーターは `.claude/workflows/` を Read/Edit しないため、パス条件では発火しない）。

### loop-observabilityログの記録漏れ検知

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

**deep ルート（`aidd-1-1-deep-task`）も 2026-09-19 から `stats` を返す**（issue #797）。
それまでは返す者が居なかったので**2 の記録が呼びようがなく、この検知そのものが機能していなかった**。
しかも「呼び忘れ」と「呼べない」を区別する手段が無いため、**警告が出ないことを「漏れが無い」と
読んでしまう**状態だった（C-025 の型）。件数は `trackedAgent()` が起動のたびに数えるので、
ラウンド数や fan-out が実行時に決まっても合う。早期 return（品質ゲート・token cap・Tree Guard）でも
そこまでに起動した分を返す。

既知の限界: stateファイルへの記録（上記1・2）自体は依然オーケストレーターの自己申告のまま（詳細は前掲の観測インフラ内部詳細を参照）。
**期待件数は「起動した数」であって「記録されるべき数」ではない**——エージェントが記録を呼ばなければ
差が出るが、それがまさに検知したいものなので、この数え方でよい。

### サブエージェント進捗の可視化（issue #18）

サブエージェント（sweep-db/sweep-ui/sweep-types/sweep-data/implementer/reviewer/integrator/
judge-panel/proposer/adversarial-verify/completeness-critic/contract-writer/spec-drafter）は、
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

現在の状態は `scripts/show-agent-status.sh` で一覧できる（既定で 180 秒以上更新の無い `running`/`waiting` を「止まってる？」と出し、7 日より古い報告は件数だけ出す。閾値と経緯は [`observability-internals.md`](./observability-internals.md#agent-progress記録の構造的限界記録内容検証の詳細)）。

記録漏れ検知は loop-observability と同じ gap check state 方式（フロー完了後に `scripts/record-gap-check-state.sh expected --agent-progress <値>`）。記録内容の正しさは `scripts/verify-agent-progress-transcript.sh` が自己申告と transcript を機械比較する。判定ロジックと既知の限界は [`observability-internals.md`](./observability-internals.md#agent-progress記録の構造的限界記録内容検証の詳細)。

## 終わり方

作業完了時の報告の形。

### 引き継ぎフォーマット

**「できました」で終わる完了報告は禁止。** 作業完了時（PR 本文・セッション終了報告・`docs/sessions/`）は
`handoff-format` スキル（[SKILL.md](../../.claude/skills/handoff-format/SKILL.md)）の形で残す
（30 秒サマリー＋00〜05 の証拠）。

- **04「どう確認したか」は表・4 値**（✅ 実施 / ➖ 今回不要 / 🟡 一部 / ⬜ 未実施）。
  行は [`test-matrix.md`](./test-matrix.md) の「毎回」「変更時」の種別に揃える。
- **04 の行と「➖ 今回不要」の理由は人が決めず、
  `bash scripts/derive-test-selection.sh origin/main --format table` の出力を貼る。**
  パスから読めない性質は `--risk authz_change,retry_possible,contention,external_side_effect` で申告する。
- **auth / RLS / facility 境界に触れたら** [`promise-catalog.md`](./promise-catalog.md) の該当する
  約束（`P-xxx`）を 03 欄に書く。新しい約束を作ったらカタログに行を足し、その ID をテストの
  `describe` 名に含める（`scripts/check-promise-catalog.test.sh` が双方向に突合する）。

Stop hook（`scripts/check-handoff-format.sh`）が PR 本文について、必須見出しの欠如と
04 表の 4 値以外・理由の無い ➖ / ⬜ を行ごとに警告する（**PR につき 1 回・warning のみ。
セッション終了報告と `docs/sessions/` 経由は検知対象外**）。
4 値化の設計判断は
[`decisions.md`](./decisions.md#なぜテスト一覧test-matrixmdと04の4値化を先に入れ機械導出deriveと約束カタログを後続prに分けたか) を参照。

## ルール・仕組みを増やす前に

**新しいルールを書く前にここを読む。** 検知手段の無いルールは静かに劣化する。

### 検査を作る前に「型」を読む（2026-09-09）

新しい検査・仕組みを作る前に
[`check-design-pitfalls.md`](./check-design-pitfalls.md)（C-xxx）を読む。
**検査そのものを設計するときの間違え方**を、実際に起きたものだけ型で並べてある
（印を実態と突き合わせない・「何かが起きた」を成功と読む・不在で判定するのに出る側の対を置かない・
壊して落ちることを確かめない・後片付けの範囲が広すぎる など）。

どれも「テストは緑のまま」潜むので、**作った本人がいちばん気づけない**。
すり抜けが 1 件出たとき（`escaped-defects.md` に行を足すとき）は、
その 1 件が既存の型か新しい型かを必ず判断する。値（閾値・列名・バリデーションの中身）は
プロジェクトごとに違うが、型は変わらないので、他リポジトリへ持ち出すのはこの表のほう。

### 検知手段のないルールの棚卸し（issue #339）

新しい運用ルールを書く前は必ず[`decisions.md`の該当原則](./decisions.md#なぜ新しい運用ルールに検知手段を先に決める原則を導入したかissue-339)を先に読むこと。
特に、新しい検知・検証メカニズム自体を追加する際は「その起動トリガーは機械（hook/CI/cron/npm test）
か人か」を先に確認すること（issue #411）。「破られても機械的に気づく手段がない」ルール（第3層）の
一覧は [`undetectable-rules-inventory.md`](./undetectable-rules-inventory.md) を参照（issue #542で
参照頻度の低い棚卸し表として本ファイルから分離）。

### fault injection訓練の実施タイミング（issue #395）

`.claude/workflows/aidd-phase2.js`のSpec Check/Manifest Check関連のプロンプトを変更したとき、
および四半期に1回の定期訓練として、実際のWorkflow実行を通じてdeny-by-defaultゲート
（Spec Check・Manifest Check）が本当に`blocked`を返すことを実測する。手順・4シナリオの期待値・
実施記録欄は[`fault-injection-drill.md`](./fault-injection-drill.md)を参照。

背景: `aidd-phase2.js`のゲート判定は実際にはエージェントへの自然言語プロンプト指示として実行
されており、`.claude/workflows/lib/`配下の純粋関数ミラーとそのテストはプロンプト文言の変更に
自動追従しない（issue #348で発覚した回避穴と同種のギャップ）。単体テストのgreenだけでは
「実行パスの本体が本当にblockedを返すこと」は証明されないため、実測訓練で埋める。

### ツール制約回避のload-bearing workaround棚卸し（issue #413）

AIDDフレームワークの相当部分がツール（Workflow DSL / `claude -p`）の制約・不具合への回避策で
できている。ツール本体を更新したとき、またはeval/ワークフロー実行が理由不明に失敗し始めた
ときは、[`load-bearing-workarounds.md`](./load-bearing-workarounds.md) を参照すること
（issue #542で参照頻度の低い棚卸し表として本ファイルから分離）。

## どこに何があるか

本ファイルに書いていないものの在り処。

### どこに何があるか（索引）

**何かを作る前に [`file-index.md`](./file-index.md) を見る。** 重要なファイル・スクリプトと目的の一覧
（hook・検査・カタログ・ワークフロー・観測基盤）。同じことをするものが既にあることが多い。
常時ロードの総量を空けるため本ファイルから分離した（2026-09-07）。限界も同ファイルに書いてある。

**新しい「ハーネス」を作りたくなったら [`harness-map.md`](./harness-map.md) を先に見る**（2026-09-09）。
8 つの役割（ワークフロー・データ・契約・実装・セキュリティ/回帰・ミューテーション・監視/観測・リリース）に
**何が揃っていて、どこが空いているか**を 1 枚にしてある。
空きには「手が届くもの」と「外部への到達が要るもの」の区別も書いてある。

**地図の表は生成物**（2026-09-10）。正本は `scripts/lib/harness-registry.json` で、
ハーネスを足したらここに 1 行足して `bash scripts/render-harness-map.sh` を回す。
**起動の欄（機械 / 人 / 外部待ち）がいちばん大事**——`人` のものは誰かが忘れれば止まる。

### 分離した参照ドキュメント

本ファイルの圧縮（issue #486・2026-09-07）で、実装詳細・経緯・導入可否の判断は下記へ移した。
必要になったときに読む。

- [`observability-internals.md`](./observability-internals.md) — 観測・Eval 基盤の実装詳細と既知の限界
  （サブエージェント骨格記録の機械強制・OpenTelemetry との役割分担・statusline・baseline スナップショット・
  Find→Adversarial Verify precision・Sweep recall・ワークフロープロンプトの eval）
- [`tooling-decisions.md`](./tooling-decisions.md) — 公式機能・プラグインの導入可否判断
  （Bash サンドボックス・Channels・claude-code-action・security-guidance・blocked ラベル・
  定期実行のトリガー・autoMode(hard_deny)）

`.claude/workflows/` 配下を Read/Edit するときは
[`workflow-eval-requirement.md`](../../.claude/rules/workflow-eval-requirement.md) が自動ロードされる（issue #445）。
