# AI エージェント設定の整理・統一プラン

## Context

医療在庫管理アプリ (medical-inventory-vkumai) の開発で使用するAIエージェント設定が、グローバル (`~/.claude/`) とプロジェクトローカル (`.claude/`) に分散している。どこに何があるか一目でわからないため、ループエンジニアリング（自律的な自動化フロー）の設計・把握が困難になっている。

整理の目標：
- 全エージェント・スキルの在処を一覧できる「マップ」を作る
- 不要になった古い worktree を削除する
- グローバル vs プロジェクトの役割分担を明文化する
- AGENTS.md をAIツールが実際に使える内容に更新する

---

## 現状の構造（調査済み）

```
~/.claude/                          ← グローバル設定
├── CLAUDE.md                       ← 言語・コミュニケーションルール・自動スキル発動
├── agents/
│   ├── ceo.md                      ← タスク委任・部門振り分け（汎用）
│   ├── code-reviewer.md            ← 汎用コードレビュー・4軸（haiku）
│   └── secretary.md                ← GitHub操作・Issue作成（汎用）
├── skills/                         ← 112スキル（デザイン系・開発系）
└── plugins/                        ← claude-mem, superpowers, code-review 等

medical-inventory-vkumai/.claude/   ← プロジェクトローカル設定
├── CLAUDE.md                       ← Parallel Subagent Framework（5フェーズ定義）
├── settings.json / settings.local.json  ← Supabase・npm・git の権限
├── agents/
│   ├── implementer.md              ← TDD実装担当（opus）
│   └── reviewer.md                 ← TDD品質レビュー・4観点（sonnet）
├── skills/
│   ├── feature-spec/               ← 仕様書生成（Phase 2用）
│   ├── structured-review/          ← 最終構造化レビュー（Phase 5後）
│   └── e2e-runner/                 ← E2Eテスト・スクリーンショット
└── worktrees/                      ← 古い残骸（削除対象）
    ├── agent-a38a2ee28f02a3dfd/    ← git worktree登録済み・削除対象
    └── agent-a8b61539094bcd9cd/    ← git worktree登録済み・削除対象
```

---

## 実施内容

### タスク 1: 古い worktree を削除

2つの worktree が `git worktree list` に登録されたまま残留している。変更なし（本体と同一内容）を確認済みなので削除する。

```bash
# プロジェクトルートで実行
git worktree remove .claude/worktrees/agent-a38a2ee28f02a3dfd --force
git worktree remove .claude/worktrees/agent-a8b61539094bcd9cd --force
git branch -d worktree-agent-a38a2ee28f02a3dfd
git branch -d worktree-agent-a8b61539094bcd9cd
```

### タスク 2: `docs/ai-config-map.md` を新規作成（マスターマップ）

`docs/ai-config-map.md` に以下を記載する：

- フォルダ階層ツリー（グローバル + プロジェクト）
- 各エージェントの一覧表（名前・モデル・役割・使いどころ）
- 各スキルの一覧表（プロジェクト固有のもの）
- グローバル vs プロジェクトの役割分担原則
- ループエンジニアリングのフロー中でどのエージェント/スキルを使うか

### タスク 3: `AGENTS.md` を実用的な内容に更新

現状は Next.js 警告のみ。以下を追加する：

- このリポジトリで使われるエージェントの一覧（名前と役割）
- プロジェクト固有スキルの説明
- 開発フロー（5フェーズ）の概要
- エージェントが参照すべき重要ファイルのパス一覧

既存の Next.js 警告ブロックは保持する（Codex用として有効）。

### タスク 4: `CLAUDE.md`（プロジェクト）の冒頭にサマリーセクションを追加

現状は Phase 1-5 の詳細のみで、エージェント構成の概要がない。冒頭に以下を追加：

```markdown
## エージェント構成（クイックリファレンス）
| エージェント | 場所 | モデル | Phase |
|---|---|---|---|
| implementer | .claude/agents/ | opus | Phase 3 実装 |
| reviewer | .claude/agents/ | sonnet | Phase 5 検証 |
| code-reviewer（汎用） | ~/.claude/agents/ | haiku | 随時 |
```

---

## 役割分担の原則（ドキュメントに明記する内容）

| 区分 | 何を置く | 例 |
|---|---|---|
| **グローバル** | プロジェクト非依存・横断的に使えるエージェント・スキル | ceo, secretary, code-reviewer, デザインスキル |
| **プロジェクトローカル** | このプロジェクト固有のプロセス・制約を持つエージェント・スキル | implementer（TDD制約付き）, reviewer（4観点固定）, feature-spec, e2e-runner |

---

## 変更ファイル一覧

| ファイル | 変更種別 |
|---|---|
| `.claude/worktrees/agent-a38a2ee28f02a3dfd/` | 削除 |
| `.claude/worktrees/agent-a8b61539094bcd9cd/` | 削除 |
| `git branch worktree-agent-*` | 削除 |
| `docs/ai-config-map.md` | 新規作成 |
| `AGENTS.md` | 更新（追記） |
| `CLAUDE.md` | 更新（冒頭にサマリー追加） |

---

## 検証方法

1. `git worktree list` で worktree が2つ消えていることを確認
2. `docs/ai-config-map.md` を開いて全エージェント・スキルが一覧できることを確認
3. `AGENTS.md` を読んで初見のAIがフローとエージェントを理解できるか確認
4. `CLAUDE.md` の冒頭でエージェント構成が即座に把握できることを確認
