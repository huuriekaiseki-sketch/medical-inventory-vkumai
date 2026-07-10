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
        ├── aidd-phase1-router.js       ← Phase 1 入口。TRI/RISKキーワードでaidd-phase1/aidd-1-1-deep-taskへ自動振り分け
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
