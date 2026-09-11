# 変更履歴（7 項目の 7 の前半。既知の制約は KNOWN-LIMITS.md）

## 0.1.0（2026-09-05、v1.0 の検証版）

- 初版。中心リポジトリの `scripts/build-plugin.sh` で `aidd-core` と `aidd-vkumai` を機械生成
- `aidd-core`: 検知 hook 28 本（SessionStart 13・compact 再注入・Setup・PreToolUse 2・SubagentStart/Stop・
  InstructionsLoaded・Stop 8）、共通関数、判定エンジンの汎用既定値、エージェント 4 体
  （reviewer / adversarial-verify / completeness-critic / judge-panel）、スキル 2 つ
  （feature-spec / structured-review）、bin 6 本（進捗・観測の記録と gap 検査）
- `aidd-vkumai`: Workflow 5 本、エージェント 7 体（sweep 4 軸・implementer・integrator・contract-writer）、
  スキル 2 つ（e2e-runner / handoff-format）、hook 5 本（readonly-bash・dependency-change・ai-check・
  automode・direct-ddl）、derive
- 導入先アダプター設定 `aidd.config.json`（スキーマ `schema/aidd-config.schema.json`）
- 実証: クリーンリポジトリで sweep 4 体が実起動（`evidence/` 参照）
- 同日修正: manifest に `hooks` を書かない（自動読み込みと重複して load 失敗）。hook 15 本の作業ディレクトリを
  `CLAUDE_PROJECT_DIR` 優先に（スクリプト位置基準だとプラグインでは導入先を指さない）
- 2026-09-06: `bin/` のスクリプトの `$SCRIPT_DIR/lib/` 参照を `../scripts/lib/` へ書き換え、gap 判定の JS を
  `scripts/workflow-lib/` に同梱。derive（04 表の機械導出）は同梱対象から外した（KNOWN-LIMITS）
- **2026-09-07: 検査（`*.test.sh`）を同梱するようにした。** それまでは hook 本体だけを配っており、
  その hook を守る検査と、hook を持たない構造テスト（カタログの形・索引の抜け・設定の形）は 1 本も
  配っていなかった。派生先には「止める仕組み」だけが渡り、「その仕組みが壊れていないことを確かめる手段」が
  渡っていなかった。対象スクリプトを持つ検査は対象と同じプラグインへ自動で付いていき、対象を持たない
  構造テストは層の表の `checks` に書く。配らないものは `checksNotDistributed` に**理由つきで**書き、
  未分類の検査があると `scripts/check-plugin-check-coverage.test.sh` が落ちる。
  aidd-core は 74 → 107 ファイル、aidd-vkumai は 31 → 39 ファイルになった
- 2026-09-06: 配布形態 (a) へ移行。marketplace `aidd-plugins`（非公開）に生成物を置き、`aidd-core--v0.1.0` /
  `aidd-vkumai--v0.1.0` をタグ付け。manifest の生成元注記を `metadata` へ、`author` を追加
- **2026-09-11: `aidd-core` にエージェント `proposer` を追加した（4 → 5 体）。** 足りていたつもりで
  1 体欠けていた——Claude 側の正本が `~/.claude/agents/`（グローバル）にしか無く、リポジトリには
  Codex 側の toml だけがあった。リポジトリへ移したあとも層の表へ足し忘れたが、**生成器は表を回るだけ**
  なのでビルドは成功し、生成物の差分にも出なかった。agent / skill / workflow の実体と層の表を
  **両方向**で突き合わせる `scripts/check-plugin-asset-coverage.test.sh` を足して塞いだ
  （hook は最初から両方向だった。型は `docs/agents/check-design-pitfalls.md` の C-047）
