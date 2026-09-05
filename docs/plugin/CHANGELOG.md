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
