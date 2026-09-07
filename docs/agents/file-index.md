# どこに何があるか（file-index）

このリポジトリの重要なファイル・スクリプトと、その目的の一覧。

**これはルールではなく索引。** 何かを作る前に「同じことをするものが既にあるか」を確かめるために読む。
`docs/agents/common.md` から分離した（2026-09-07）。理由は 2 つ:

- **常時ロードの総量を空けるため。** `common.md` は `CLAUDE.md` の `@import` で毎セッション読み込まれ、
  この表はその 34%（6,871 字）を占めていた。**探すときだけ要るもの**を常に持ち歩く必要はない。
- **ルールと索引は寿命が違う。** ルールは滅多に変わらないが、この表はファイルが増えるたびに伸びる。
  同じファイルに置くと、索引が伸びるたびにルールを載せる余地が削られる。

## 既知の限界

- **読まれる保証が無い。** `common.md` にあったときは必ず目に入ったが、ここは読みに来ないと分からない。
  そのぶん「既にあるスクリプトを知らずに作り直す」事故が起こりうる。
  緩和は `common.md` からのポインタ 1 行と、`scripts/` を `grep` で引けること。**それ以上の保証は無い。**
- **この表の網羅性は誰も検査していない。** 新しいスクリプトを足しても、ここに書かなければ載らない。
  リンク切れ（消えたファイルを指したまま）は `scripts/lib/check-docs-integrity.mjs` が検知するが、
  「載せ忘れ」は検知できない。
- ルールブック（カタログ）の一覧は自動生成の [`rulebooks.md`](./rulebooks.md) が正本で、
  この表とは別物。ここに載っていないルールブックがありうる。

## 一覧

| ファイル | 目的 |
|---|---|
| [`docs/agents/common.md`](./common.md) | 全AIエージェント共通ルール（本ファイル）・引き継ぎフォーマット |
| [`docs/agents/observability-internals.md`](./observability-internals.md) | 観測・Eval基盤の実装詳細・既知の限界（common.mdから分離、issue #486） |
| [`docs/agents/test-matrix.md`](./test-matrix.md) | テスト種別ごとの実施タイミング（毎回/変更時/節目/一度きり）・トリガー・証跡・derive キーの正本。`scripts/check-test-matrix.test.sh`が整合を検査 |
| [`docs/agents/promise-catalog.md`](./promise-catalog.md) | auth / RLS / facility 境界の約束カタログ（AAA、`P-xxx`）。守るテストの `describe` 名に ID を書き、`scripts/check-promise-catalog.test.sh` が双方向に突合 |
| [`docs/agents/invariant-catalog.md`](./invariant-catalog.md) | 業務不変条件（`I-xxx`）。DB の CHECK / トリガーが守り、構造テストがテストと突合 |
| [`docs/agents/design-questions.md`](./design-questions.md) | 新しいテーブル・API・外部送信を作る**前に**人に聞く質問の一覧。2026-09-07 の点検で見つけた実害が全て「作る前に聞いていれば防げた」ものだったことから作った。決めた値もここに残す |
| [`docs/agents/security-test-catalog.md`](./security-test-catalog.md) | ルーチン外の検査の引き出し。新機能・事故・公開時に引き金列を読み #757 へ昇格 |
| [`docs/agents/threat-model.md`](./threat-model.md) | 脅威モデル（`T-xxx`）と守る検査（P / I / #757）の対応表。全 P / I がどれかの脅威に紐づくことを構造テストが検査 |
| `scripts/derive-test-selection.sh` / `scripts/lib/derive-test-selection.mjs` / `scripts/lib/derive-test-selection.rules.mjs` | 変更ファイルから「今回必須 / 今回不要（理由付き）」を機械導出し 04 表を出す（PR②）。エンジン（共通）とルール表（固有）を分離。高リスク判定は`router-risk.js`を参照 |
| [`docs/agents/tooling-decisions.md`](./tooling-decisions.md) | 公式機能・プラグインの導入可否判断記録（common.mdから分離、issue #486） |
| [`docs/agents/actuator-inventory.md`](./actuator-inventory.md) | 検知hookの検知後の是正（block/自動復旧/warning-only）の棚卸し（issue #578） |
| [`docs/agents/portability-inventory.md`](./portability-inventory.md) | 多リポジトリ展開に向けたドメイン非依存/スタック依存の切り分け棚卸し（issue #535） |
| [`docs/agents/parallel-agent-work.md`](./parallel-agent-work.md) | Claude Code / Codex 並行作業ルール（同一worktree同時作業禁止・状態分離） |
| [`docs/agents/claude-codex-coexistence-template.md`](./claude-codex-coexistence-template.md) | Claude/Codex共存設計のリポジトリ非依存テンプレート（9原則・実機検証手順・移植チェックリスト） |
| `scripts/check-branch-tool-ownership.sh` | ブランチ命名規約（codex/*・claude/*）と起動ツールの取り違えをSessionStartで警告（両ツール共有） |
| `scripts/codex-skip-marker-deny.sh` | Codex用ask→deny変換ラッパー（Codexはask未対応のため） |
| `docs/ai-config-map.md` | エージェント・スキル全体マップ |
| `src/app/` | Next.js App Router のページ・API Routes |
| `src/components/` | UI コンポーネント |
| `src/lib/supabase/` | Supabase クライアント・データ取得層 |
| `supabase/migrations/` | DBマイグレーション |
| `scripts/create-worktree.sh` | worktree作成 + `.env.local`/`.env.test`自動コピー（「ブランチ運用ルール」参照） |
| [`docs/agents/run-manifest.md`](./run-manifest.md) | AIDDフローのspecHash/baseCommit突合用Run Manifestのスキーマ |
| `scripts/log-agent-progress.sh` / `scripts/show-agent-status.sh` | サブエージェント進捗の記録・一覧表示（issue #18） |
| `aidd.config.json` / `scripts/lib/aidd-config.sh` | 導入先アダプター設定（issue #420）。TRI/RISK の固有語彙・読み取り専用ロール・検査コマンド・追記先 docs。判定エンジンと hook 4 本が読み、値は汎用既定値に足すだけで消せない |
| `scripts/build-plugin.sh` / `scripts/lib/plugin-layout.json` | プラグイン v1 の生成（issue #420）。層の表に従い `dist/plugins/` を機械生成し、禁止語・同梱閉包・決定性を検査。配布は `--marketplace --out ~/aidd-plugins/plugins`（版は `{plugin}--v{version}` タグ）。`build-plugin.test.sh` が dist の鮮度を見る |
| `scripts/lib/resolve-log-dir.sh` | `logs/`の書き込み先をworktree横断で単一のディレクトリ（メインworktree直下）に解決する。全`log-*.sh`/`check-*.sh`/`summarize-*.sh`が参照する（issue #546。worktreeごとに別の`logs/`へ書いて観測記録の約半数が死蔵していた対策） |
| `scripts/lib/canonical-event.ts` | hook/journal/agent-progress/loop-observabilityの4ログを正規化する読み取り専用Adapter層（issue #569） |
| `scripts/harvest-journal-events.sh` / `scripts/lib/harvest-journal-events.ts` | Workflow journal(wf_*)をtranscript cleanupで消える前に`logs/journal-harvest.jsonl`へ収穫（Stop hook契機・重複排除。issue #642） |
| `scripts/summarize-gate-passfail.sh` / `scripts/lib/gate-effectiveness-summary.ts` | 収穫済みjournalからagentType別pass/fail/blockedを集計し月次品質ゲートサマリへ出力（issue #569・#642） |
| `.claude/workflows/lib/constraint-coverage.js` | DB制約・RLS/admin境界・公開RPCの「守るテストが無い穴」の判定ロジック正本（issue #675、P-043） |
| `scripts/check-constraint-coverage.sh` | 現存する穴を**怪しい順**に表示。新規発生の阻止は`supabase/migrations/__tests__/constraint_coverage_ratchet.test.ts`が`npm test`で行う |
| `scripts/check-agent-progress-gap.sh` | agent-progress記録漏れの機械検知（issue #339） |
| `scripts/record-gap-check-state.sh` | gap check用before/expected件数の記録（issue #488。オーケストレーター専用） |
| `scripts/check-gap-check-state.sh` | Stop hookによるgap checkの自動実行（issue #488） |
| `scripts/check-aidd-stats-recorded.sh` | Stop hookによるAIDD stats start呼び忘れの機械検知（issue #495） |
| `scripts/check-aidd-phase-stats-recorded.sh` | Stop hookによるAIDD stats phase1/phase2呼び忘れの機械検知（issue #524） |
| `scripts/check-handoff-format.sh` | Stop hookによるPR本文の引き継ぎフォーマット必須見出し欠如の機械検知（issue #524） |
| `scripts/check-find-av-precision-recorded.sh` | Stop hookによるfind-av-precisionログ記録漏れの機械検知（issue #522） |
| [`docs/agents/recovery-queue.md`](./recovery-queue.md) | 検知後の自動復旧閉ループの設計・スコープ・既知の限界（issue #523） |
| `scripts/queue-recovery-task.sh` | 検知hookから呼ばれ`.aidd/recovery-queue.jsonl`へ復旧タスクを登録する（issue #523） |
| `scripts/check-recovery-queue.sh` | SessionStart hookによる未解決の復旧タスクのcontext注入・surfaced放置エントリのエスカレーション（issue #523・#579） |
| `scripts/resolve-recovery-task.sh` | 復旧タスク対応後に`status`を`"resolved"`へ書き換える（issue #579） |
| `scripts/check-workflow-interruption.sh` | SessionStart hookによるWorkflow中断検知(`wf_*.json`のstatus/staleness判定)とrecovery-queueへの登録（issue #534） |
| [`docs/agents/fault-injection-drill.md`](./fault-injection-drill.md) | `aidd-phase2.js`のdeny-by-defaultゲート実測訓練のランブック（issue #395） |
| [`docs/agents/hook-live-drill.md`](./hook-live-drill.md) | 全 hook を現在セッションの実データで実走し、fail-open の無音死を見つけるランブックと実施記録（2026-09-05 初回で 7 件発見。プラグイン v1 前の必須作業） |
| [`docs/agents/upstream-docs-review.md`](./upstream-docs-review.md) | Claude Code / Anthropic / Codex の公式ドキュメント差分を月 1 で確認する手順・実施記録・「最後に確認した版」（v1 の対応バージョンの正本）。期限は `scripts/check-upstream-docs-review-staleness.sh` が SessionStart で警告 |
| `scripts/maintenance-digest.sh` | 定期作業 3 つ（fault-injection 訓練・hook 実走ドリル・docs 差分確認）の期限を一括表示。`claude -p --maintenance`（Setup hook）または手動実行（issue #741） |
| `scripts/log-instructions-loaded.sh` / `scripts/summarize-instructions-loaded.sh` | InstructionsLoaded hook で実際に読み込まれた CLAUDE.md / rules を `logs/instructions-loaded.jsonl` に記録し、常時ロード量と rules 別ロード回数を集計する（issue #742。月次サマリにも載る） |
| `scripts/check-subagent-model-force.sh` | `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` が設定されていると agent ごとの model 指定が黙って無効化されるため SessionStart で警告（issue #743） |
| `scripts/aidd-fault-injection-setup.sh` / `scripts/aidd-fault-injection-teardown.sh` | fault injection訓練用の`.aidd/run-manifest.json`差し替え・復元（issue #395） |
| `scripts/eval-workflow-prompts.sh` / `scripts/eval-fixtures/` | AIDDワークフロープロンプトのeval基盤（issue #391） |
| `.claude/workflows/lib/prompts/` | ワークフロー内プロンプト文字列の正本（Workflow DSL側へはインライン複製、sync testで乖離検知） |
| `.claude/workflows/lib/budget-guard.js` | Loop Until Dryへのbudgetガード判定ロジックの正本（issue #442） |
| [`docs/agents/workflow-resume-runbook.md`](./workflow-resume-runbook.md) | Workflow実行が中断した際の`resumeFromRunId`再開手順（issue #442） |
