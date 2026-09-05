# 移行手順（7 項目の 3）

## v0（手コピー）→ v1（プラグイン）

v0 は中心リポジトリの `.claude/` と `scripts/` を導入先へ手でコピーしていた形（riff-gear / cardiosearch）。

1. **インストール**（検証中は `--plugin-dir`、最終形は `claude plugin install`）
   - `claude --plugin-dir <path>/aidd-core --plugin-dir <path>/aidd-vkumai`
   - 依存: `aidd-vkumai` は `aidd-core` を要求する
2. **導入先アダプターを置く**（`templates/consumer/` をコピーして値を埋める）
   - `aidd.config.json`: 高リスクの語・パス、読み取り専用ロール、検査コマンド、追記先 docs
   - `.claude/rules/*.md`: パス限定ルール（プラグインは同梱できない）
   - `CLAUDE.md`: フローの骨格と、Workflow の呼び方（修飾名）
   - `.claude/workflows/aidd-phase1-router.js`（wrapper）: `aidd.config.json` の `risk` を
     `args.riskConfig` として `aidd-vkumai:aidd-phase1-router` に渡す
3. **手コピーした旧ファイルを消す**
   - `.claude/agents/`・`.claude/skills/`・`.claude/workflows/`（wrapper 以外）・`scripts/` のうち、
     プラグインに同梱されたもの（`plugin-layout.json` の一覧）。残すと二重に定義される
   - `.claude/settings.json` の hooks のうち、プラグインの `hooks/hooks.json` に移ったもの。残すと二重に発火する
4. **呼び方を修飾名に変える**
   - `Workflow({ name: 'aidd-phase1-router' })` → `Workflow({ name: 'aidd-vkumai:aidd-phase1-router' })`
   - agent 名も同様（`aidd-core:reviewer` / `aidd-vkumai:sweep-ui`）
5. **確認**
   - 新規セッションを起動し、SessionStart の警告が出ること（ブランチ・worktree・docs の期限）
   - `Workflow({ name: 'aidd-vkumai:aidd-phase1' })` で sweep 4 体が起動し `failedCount: 0`
   - `logs/` に `instructions-loaded.jsonl` と `subagent-skeleton.jsonl` が増える

## v1 → v2（未定）

v1 を 2 リポジトリで回してから決める。候補: プラグインを正本にし中心リポジトリも消費者にする反転、
Workflow の共通側への移動（`args.agentNamespace`）。
