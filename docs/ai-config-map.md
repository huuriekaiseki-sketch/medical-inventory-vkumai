# AI エージェント設定マップ

このプロジェクトで使われる Claude Code のエージェント・スキル設定の全体マップ。
ループエンジニアリング（自律的自動化フロー）の設計・把握に使う。

---

## フォルダ階層

```
~/.claude/                              ← グローバル設定（全プロジェクト共通）
├── CLAUDE.md                           ← 言語・通信ルール・自動スキル発動ルール
├── settings.json                       ← グローバル権限・hooks・プラグイン設定
├── agents/
│   ├── ceo.md                          ← CEO：タスク委任・部門エージェントへの振り分け
│   ├── code-reviewer.md                ← 汎用コードレビュー（4軸: 品質・設計・セキュリティ・性能）
│   ├── proposer.md                     ← 設計提案（Judge Panelフェーズで並列起動）
│   └── secretary.md                    ← 秘書：GitHub Issue作成・ファイル管理
├── skills/                             ← 112スキル（デザイン系・開発系・ドキュメント系）
└── plugins/                            ← インストール済みプラグイン
    ├── claude-mem/                     ← 永続メモリ（セッション横断記憶）
    ├── superpowers/                    ← マルチエージェント計画・デバッグスキル群
    ├── code-review/                    ← コードレビュー自動化
    ├── session-report/                 ← セッションレポート生成
    ├── exa/                            ← Web検索
    ├── hookify/                        ← hooks設定支援
    └── linear/                         ← Linear連携

medical-inventory-vkumai/               ← このプロジェクト
├── CLAUDE.md                           ← Parallel Subagent Framework（5フェーズ定義）
├── AGENTS.md                           ← AIツール向けエージェント/スキル一覧
└── .claude/                            ← プロジェクトローカル設定
    ├── settings.json                   ← Supabase・npm・git 権限
    ├── settings.local.json             ← ローカル拡張権限
    ├── agents/
    │   ├── sweep-ui.md                 ← Phase 1: UI層Sweep（haiku）
    │   ├── sweep-data.md               ← Phase 1: データ取得層Sweep（haiku）
    │   ├── sweep-db.md                 ← Phase 1: DB層Sweep（haiku）
    │   ├── sweep-types.md              ← Phase 1: 型整合性Sweep（haiku）
    │   ├── completeness-critic.md      ← Phase 1: 調査網羅チェック（sonnet）
    │   ├── contract-writer.md          ← Phase 3 前: 型定義・API契約確定（sonnet）
    │   ├── implementer.md              ← Phase 3: TDD実装（opus）・契約参照前提
    │   ├── integrator.md               ← Phase 4: 統合ゲート（sonnet）
    │   ├── reviewer.md                 ← Phase 5: 品質レビュー4観点（sonnet）
    │   ├── adversarial-verify.md       ← 深掘り調査: 偽陽性除去（opus）
    │   └── judge-panel.md              ← 深掘り調査: 設計提案評価・synthesis（sonnet）
    ├── skills/
    │   ├── feature-spec/SKILL.md       ← 仕様書生成（Phase 2）
    │   ├── structured-review/SKILL.md  ← 最終構造化レビュー（Phase 5後）
    │   └── e2e-runner/SKILL.md         ← E2Eテスト・スクリーンショット
    └── workflows/
        ├── aidd-phase1-router.js       ← Phase 1 入口。TRI/RISKキーワードでaidd-phase1/aidd-1-1-deep-task/メタ改修軽量ルート(issue #457)へ自動振り分け
        ├── aidd-phase1.js              ← Phase 1 調査ワークフロー（軽量Sweep。routerから呼ばれる）
        ├── aidd-phase2.js              ← Phase 3-5 実装〜検証ワークフロー
        ├── aidd-1-1-deep-task.js       ← 深掘り調査・仕様検証（routerから高リスク判定時に呼ばれる）
        └── aidd-session-report.js      ← セッションレポート生成
```

---

## エージェント一覧

### グローバルエージェント（`~/.claude/agents/`）

| エージェント | モデル | tools | 役割 | いつ使う |
|---|---|---|---|---|
| `ceo` | sonnet | Agent | 部門エージェントへタスク委任・結果統合 | 複雑なタスクを分解したいとき |
| `code-reviewer` | haiku | Read, Bash | 汎用コードレビュー（4軸）読み取り専用 | 任意のコードレビュー依頼 |
| `proposer` | sonnet | Read | 設計アプローチを1案提案（スタンス指定で起動） | Judge Panelフェーズで並列起動 |
| `secretary` | sonnet | Bash, Read, Write, GitHub MCP | GitHub Issue作成・ファイル管理 | Issue化・ドキュメント管理 |

### プロジェクトローカルエージェント（`.claude/agents/`）

#### Phase 1: 調査（4軸並列Sweep）

| エージェント | モデル | 役割 |
|---|---|---|
| `sweep-ui` | haiku | src/app/・src/components/ を調査。コンポーネント・props・stateのバグ・型エラーを報告 |
| `sweep-data` | haiku | src/lib/supabase/ とAPIルートを調査。型エラー・セキュリティ問題・設計違反を報告 |
| `sweep-db` | haiku | Supabaseスキーマ・マイグレーション・RLSを調査。整合性・設計・セキュリティ問題を報告 |
| `sweep-types` | haiku | 型定義・mappers・DB列・UIプロップスを縦断調査。層をまたぐ型不一致・欠落を報告 |
| `completeness-critic` | sonnet | 各ラウンド末に起動。未調査モダリティ・未検証クレーム・未読ソースを検出 |

#### Phase 3〜5: 実装・統合・検証

| エージェント | モデル | 役割 | いつ使う |
|---|---|---|---|
| `contract-writer` | sonnet | src/types/ の型定義・APIインターフェース型を先行確定。implementerへの「契約」を書く。route.ts・migrations は触らない | Phase 3 実装前（contract-first）|
| `implementer` | sonnet | TDD実装（RED→GREEN→REFACTOR）。src/types/ の型定義は変更しない。テスト削除・期待値改ざん禁止 | Phase 3 実装（並列） |
| `integrator` | sonnet | マイグレーション適用確認・共有ファイルの結線・npm test/lint確認 | Phase 4 統合ゲート |
| `reviewer` | sonnet | コード品質4観点（正しさ/仕様カバレッジ/重複/型安全）。読み取り専用 | Phase 5 検証（並列） |

#### 深掘り調査・仕様検証（オンデマンド）

| エージェント | モデル | 役割 |
|---|---|---|
| `adversarial-verify` | opus | Sweep指摘に反論を試み、偽陽性を除去。読み取り専用 |
| `judge-panel` | sonnet | 複数の設計提案を評価・採点し、synthesis（統合提案）を作成。読み取り専用 |

---

## effort/model指定がどの実行経路に効くか（issue #433）

`.claude/agents/*.md`のfrontmatter（`model:`/`effort:`）は、そのagentTypeを**agentType経由で
呼び出した場合にのみ**適用される。一方、`.claude/workflows/*.js`内には同じ役割を担うのに
frontmatterを一切参照せず`opts.model`/`opts.effort`を直接指定しているインライン実装が複数あり、
frontmatterを変更しても実フローの挙動が変わらないケースがある（issue #419実装時に発覚。
詳細はissue #419のPR #422コメント「重要な発見」参照）。

**この二重管理はプロンプト正本問題（`workflow-prompt-sync.test.js`）と同型のドリフトリスクを
持つが、意図的な差異（後述）があるため単純な一字一致sync testは適用できない。**

### 対応表

| agentType | frontmatter (model/effort) | 実際に効く経路 | 備考 |
|---|---|---|---|
| `sweep-ui` / `sweep-data` / `sweep-db` / `sweep-types` | haiku / low | ✅ `aidd-phase1.js`・`aidd-1-1-deep-task.js`が`agentType:'sweep-*'`で呼ぶ（`effort:'low'`もインラインで明示再指定、frontmatterと重複するが一致） | frontmatterとインライン指定が一致している健全なケース |
| `contract-writer` | sonnet / (指定なし) | ✅ `aidd-phase2.js`が`agentType:'contract-writer'`で呼ぶ | frontmatterがそのまま適用される |
| `implementer` | sonnet / (指定なし) | ✅ `aidd-phase2.js`（db-impl/data-impl/api-impl/ui-impl/implementer-retry）・`aidd-session-report.js`（report-writer）が`agentType:'implementer'`で呼ぶ | 同上 |
| `integrator` | sonnet / (指定なし) | ✅ `aidd-phase2.js`が`agentType:'integrator'`で呼ぶ | 同上 |
| `reviewer` | sonnet / (指定なし) | ✅ `aidd-phase2.js`（spec-check/manifest-check/review:*）が`agentType:'reviewer'`で呼ぶ | 同上 |
| `completeness-critic` | sonnet / (指定なし) | ⚠️ **一部のみ**: `aidd-1-1-deep-task.js`のPhase 1ラウンド末の`critic:R${round}`呼び出しは`agentType:'completeness-critic'`経由（frontmatterが効く）。一方、Find/Adversarial Verify後の2回目のcritic呼び出し（`completeness-critic-2`）は`agentType`を使わず`model:'claude-sonnet-4-6', effort:'medium'`を直接指定（frontmatterは効かない） | 同名の役割が2箇所で呼ばれ、片方だけagentType経由という非対称なケース |
| `adversarial-verify` | opus / **xhigh** | ❌ **効かない（Workflow内）**。`aidd-1-1-deep-task.js`のAdversarial Verifyフェーズは`agentType`を使わず`model:'claude-opus-4-8', effort:'medium'`を直接指定 | frontmatterのeffort変更が反映されるのは、Agent toolで直接`subagent_type:"adversarial-verify"`を呼ぶ経路（spec-deep-validateフロー、オーケストレーターが手動で呼ぶ場合）のみ |
| `judge-panel` | sonnet / **xhigh** | ❌ **効かない（Workflow内）**。`aidd-1-1-deep-task.js`のJudge Panelフェーズは`agentType`を使わず、提案生成（`propose:*`、`model:'claude-sonnet-4-6', effort:'medium'`）と採点（`score:*:*`、`model:'claude-haiku-4-5-20251001', effort:'low'`、**意図的に安価な構成**）に分かれてそれぞれ直接指定 | 同上。採点は3案×3観点=最大9並列のため、意図的にhaiku+lowでコストを抑えている（frontmatterのxhighをそのまま適用すると採点コストが跳ね上がる） |
| `proposer`（`~/.claude/agents/proposer.md`、グローバル） | sonnet / (指定なし) | ❌ **効かない（Workflow内）**。`aidd-1-1-deep-task.js`のJudge Panel「propose」呼び出しは`agentType:'proposer'`を使わず`model:'claude-sonnet-4-6', effort:'medium'`を直接指定 | frontmatterが効くのは、Agent toolで直接`subagent_type:"proposer"`を呼ぶ経路（spec-deep-validateフロー）のみ |

### 意図的な差異（単純sync test化できない理由）

- **judge-panelの採点フェーズ**: frontmatterは`effort: xhigh`だが、採点は意図的に`haiku` +
  `effort: low`にしている（3案×3観点の並列採点でコストが跳ね上がるのを防ぐため）。
  frontmatterと一致させることは設計上望ましくない
- **adversarial-verify**: frontmatterは`effort: xhigh`だが、Workflow内は`effort: medium`。
  Workflow内の反証は1指摘ずつ並列実行されるため、xhighにすると指摘数に比例してコストが
  増大する。frontmatter（Agent tool直接呼び出し用の重量設定）とWorkflow内（大量並列実行用の
  軽量設定）は意図的に別配分にしている
- **completeness-criticの2箇所呼び出し**: 1回目（ラウンド末、agentType経由）と2回目
  （Find/Adversarial Verify後、インライン）は文脈が異なる別々の批評であり、常に同じ設定に
  揃える必要はない

### 将来この対応表を機械的に同期させたくなった場合の注意

`workflow-prompt-sync.test.js`と同じパターン（正本を切り出し、インライン複製との一致をテストで
検証）をそのまま適用することはできない。上記のとおり意図的な差異があるため、単純な一字一致
チェックではなく、**「frontmatterと異なる値を意図的に使ってよいagentType×呼び出し箇所」の
例外リスト**を持つ設計が必須。例外リストが陳腐化しないよう、例外を追加する際はこの表と
`docs/agents/decisions.md`に理由を記録すること。

---

## プロジェクト固有スキル（`.claude/skills/`）

| スキル | いつ呼ぶ | 出力 |
|---|---|---|
| `feature-spec` | Phase 2：調査結果から仕様書を生成するとき | `SPEC.md`（Part 1: 人間向け / Part 2: AI向け技術詳細） |
| `structured-review` | Phase 5 後：最終構造化レビューを実施するとき（`/structured-review` で起動） | レビュー観点別の指摘リスト |
| `e2e-runner` | E2Eテストやスクリーンショットが必要なとき（随時） | Playwright テスト + スクリーンショット |

---

## 開発フロー（Phase 1-5）とエージェントの対応

```
Phase 1: 調査  ← aidd-phase1-router.js（正式な入口）
  → taskDescriptionをTRI/RISKキーワード（migrations/auth/facility/tenant/
    organization/inventory/RLS/policy等）に照合し、機械的に自動振り分け
  → 該当なし: aidd-phase1.js（軽量Sweep、4エージェント）
     sweep-ui / sweep-data / sweep-db / sweep-types を並列起動
  → 該当あり: aidd-1-1-deep-task.js（深掘り、adversarial-verify / judge-panel / proposer 等）
     Sweep+Loop Until Dry→Draft Spec→Find→Adversarial Verify→Completeness Critic
     →Judge Panel→Synthesizeの8フェーズをフル実行
  → completeness-critic で網羅性チェック・終了判定

  ⚠️ コスト差は一桁以上ある（実測値、2026-07-10検証）：
     軽量版: 4エージェント / 数分
     深掘り版: 75エージェント / 約27分 / 約217万トークン
  false positive（軽微なタスクが深掘りに誤って回ること）は意図的に許容している
  （common.md TRI/RISK原則「迷ったら高リスク側に倒す」）。false negative（高リスク
  変更の見逃し）よりコスト増の方が安全という判断。理由は decisions.md 参照。

Phase 2: 仕様書  [skill: feature-spec]
  → SPEC.md 生成（Part 1 を人間にレビューしてもらう）
  ⚠️ 停止①：人間が承認するまで Phase 3 へ進まない

Phase 3: 実装 [agent: contract-writer + implementer × 並列]  ← aidd-phase2.js
  → contract-writer（src/types/ 確定）+ db-impl（migrations）を並列
  → data-impl / api-impl / ui-impl を並列（src/types/ を契約として参照）
  → 各自 RED → GREEN → REFACTOR（型定義は変更しない）

Phase 4: 統合ゲート [agent: integrator]  ← aidd-phase2.js
  → 共有ファイルの結線・全テスト + lint 確認

Phase 5: 検証 [agent: reviewer × 並列 4観点]  ← aidd-phase2.js
  → 正しさ / 仕様カバレッジ / 重複 / 型安全 を並列確認
  ⚠️ 停止②：/structured-review で人間が起動するまで勝手に実行しない
```

---

## グローバル vs プロジェクトの役割分担原則

| 区分 | 何を置く | 理由 |
|---|---|---|
| **グローバル** (`~/.claude/`) | プロジェクト非依存・横断的に使えるエージェント・スキル | どのリポジトリでも再利用できる汎用ロール |
| **プロジェクトローカル** (`.claude/`) | このプロジェクト固有のプロセス・制約を持つエージェント・スキル | TDD制約・Supabase権限・5フェーズフローなどプロジェクト固有のルールを含む |

**判断基準：** 「別のプロジェクトでそのまま使えるか？」→ Yes ならグローバル、No ならローカル。

---

## 関連ファイル

| ファイル | 目的 |
|---|---|
| `CLAUDE.md` | Phase 1-5 の詳細フロー定義・絶対ルール |
| `AGENTS.md` | AIツール向けクイックリファレンス |
| `.claude/settings.json` | Bash/MCP 権限リスト（Supabase・npm・git） |
| `.claude/workflows/aidd-phase1-router.js` | Phase 1 正式入口。TRI/RISK自動振り分け（argsのJSON.parse防御理由はdecisions.md参照） |
| `.claude/workflows/aidd-phase1.js` | Phase 1 軽量Sweepワークフロー実装（routerから呼ばれる） |
| `.claude/workflows/aidd-phase2.js` | Phase 3-5 ワークフロー実装（args・完了後手順） |
| `.claude/workflows/aidd-1-1-deep-task.js` | 深掘り調査ワークフロー（オンデマンド） |
| `docs/ai-config-map.md` | このファイル（全体マップ） |
