# 移行手順（7 項目の 3）

## v0（手コピー）→ v1（プラグイン）

v0 は中心リポジトリの `.claude/` と `scripts/` を導入先へ手でコピーしていた形（riff-gear / cardiosearch）。

1. **インストール**（marketplace `aidd-plugins`。非公開リポジトリなので `gh auth login` 済みの環境で）
   - `claude plugin marketplace add huuriekaiseki-sketch/aidd-plugins`
   - 導入先リポジトリで `claude plugin install aidd-vkumai@aidd-plugins --scope project`
     （依存の `aidd-core` は自動で入る。共通側だけ使うなら `aidd-core@aidd-plugins`）
   - 開発中の生成物を直接読むなら `claude --plugin-dir <path>/aidd-core --plugin-dir <path>/aidd-vkumai`
2. **導入先アダプターを置く**（`templates/consumer/` をコピーして値を埋める）
   - `aidd.config.json`: 高リスクの語・パス、読み取り専用ロール、検査コマンド、追記先 docs
   - `.claude/rules/*.md`: パス限定ルール（プラグインは同梱できない）
   - `CLAUDE.md`: フローの骨格と、Workflow の呼び方（修飾名）
   - **Workflow は置かない。** 入口は `aidd-vkumai:aidd-phase1-router` を**セッションから直接**呼び、
     `aidd.config.json` の `risk` を `args.riskConfig` として渡す。
     wrapper Workflow を置くと wrapper → router → phase1 で**入れ子が 2 段**になり、
     エージェントを 1 体も起動しないまま失敗する（2026-09-12 実測。E-085）
3. **手コピーした旧ファイルを消す**
   - `.claude/agents/`・`.claude/skills/`・`.claude/workflows/`（wrapper 以外）・`scripts/` のうち、
     プラグインに同梱されたもの（`plugin-layout.json` の一覧）。残すと二重に定義される
   - `.claude/settings.json` の hooks のうち、プラグインの `hooks/hooks.json` に移ったもの。残すと二重に発火する
4. **呼び方を修飾名に変える**
   - `Workflow({ name: 'aidd-phase1-router' })` →
     `Workflow({ name: 'aidd-vkumai:aidd-phase1-router', args: { taskDescription, changedFiles, riskConfig } })`
     （`riskConfig` は `aidd.config.json` の `risk` と同じ値。Workflow は導入先のファイルを読めないので
     **呼ぶ側が渡す**。既定値に足すだけで、既定値は消せない）
   - agent 名も同様（`aidd-core:reviewer` / `aidd-vkumai:sweep-ui`）
5. **確認**
   - 新規セッションを起動し、SessionStart の警告が出ること（ブランチ・worktree・docs の期限）
   - `Workflow({ name: 'aidd-vkumai:aidd-phase1-router', args: { ... } })` で sweep 4 体が起動し `failedCount: 0`
     （2026-09-12 に導入先を模したリポジトリで実測: sweep 4 体・72 秒・$0.58・指摘 12 件）
   - `logs/` に `instructions-loaded.jsonl` と `subagent-skeleton.jsonl` が増える
6. **配った検査を回す**
   - `aidd-check.sh --list` で、この導入先で回る検査を確認する
     （`self`＝配っているスクリプト自身の単体テストは回らない。
     aidd-core の `bin/` は Bash の PATH に足されるので、裸の名前で呼ぶ）
   - `aidd-check.sh` で実際に回す。導入先のルートは `CLAUDE_PROJECT_DIR` で決まる
   - **いまは `both` の多くがプラグイン自身を見ている**（KNOWN-LIMITS 参照）。
     赤が出たら、まずその検査が導入先を見ているかを確かめる

## v1 → v2（未定）

v1 を 2 リポジトリで回してから決める。候補: プラグインを正本にし中心リポジトリも消費者にする反転、
Workflow の共通側への移動（`args.agentNamespace`）。
