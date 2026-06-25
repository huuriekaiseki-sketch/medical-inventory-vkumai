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
    │   ├── implementer.md              ← TDD実装担当（opus）
    │   └── reviewer.md                 ← TDD品質レビュー・4観点（sonnet）
    ├── skills/
    │   ├── feature-spec/SKILL.md       ← 仕様書生成（Phase 2）
    │   ├── structured-review/SKILL.md  ← 最終構造化レビュー（Phase 5後）
    │   └── e2e-runner/SKILL.md         ← E2Eテスト・スクリーンショット
    └── worktrees/
        └── vectorized-stargazing-lamport/  ← アクティブworktree（削除禁止）
```

---

## エージェント一覧

### グローバルエージェント（`~/.claude/agents/`）

| エージェント | モデル | tools | 役割 | いつ使う |
|---|---|---|---|---|
| `ceo` | — | Agent | 部門エージェントへタスク委任・結果統合 | 複雑なタスクを分解したいとき |
| `code-reviewer` | haiku | Read, Bash | 汎用コードレビュー（4軸）読み取り専用 | 任意のコードレビュー依頼 |
| `secretary` | — | Bash, Read, Write, GitHub MCP | GitHub Issue作成・ファイル管理 | Issue化・ドキュメント管理 |

### プロジェクトローカルエージェント（`.claude/agents/`）

| エージェント | モデル | tools | 役割 | いつ使う |
|---|---|---|---|---|
| `implementer` | opus | Read, Edit, Write, Bash | TDD実装（RED→GREEN→REFACTOR）。テスト削除・期待値改ざん禁止 | Phase 3 実装 |
| `reviewer` | sonnet | Read, Grep, Glob, Bash | TDD品質規約検証・4観点指摘（正しさ/仕様カバレッジ/重複/型安全）。読み取り専用 | Phase 5 検証 |

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
Phase 1: 調査（並列 4軸 Explore）
  → UI層 / データ取得層 / DB層 / 型整合性 を並列調査
  → Completeness Critic で終了判定

Phase 2: 仕様書 [skill: feature-spec]
  → SPEC.md 生成（Part 1 を人間にレビューしてもらう）
  ⚠️ 停止①：人間が承認するまで Phase 3 へ進まない

Phase 3: 実装 [agent: implementer × 並列]
  → 仕様書 Part 2 の並列グループごとに implementer を同時起動
  → 各自 RED → GREEN → REFACTOR

Phase 4: 統合ゲート（親が逐次）
  → 共有ファイルの結線・全テスト + lint 確認

Phase 5: 検証 [agent: reviewer × 並列 4観点]
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
| `docs/ai-config-map.md` | このファイル（全体マップ） |
