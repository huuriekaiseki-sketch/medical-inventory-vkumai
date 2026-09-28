# 変更履歴（7 項目の 7 の前半。既知の制約は KNOWN-LIMITS.md）

## 0.1.2（2026-09-28）

- 版を**変えた**更新の実測用（RELEASE.md §7 の残り: Codex で版が変わっても `trusted_hash` が維持されるか、
  remove 無しの `add` で入れ替わるか）。中身の差は 0.1.1 配布後に書き戻した文書
  （KNOWN-LIMITS「update は依存を連れて上がらない」、COMPATIBILITY の 0.1.1 実測値、Codex の実証記録）のみ
- hook 定義（`hooks/hooks.json`）・スクリプト・エージェント・スキルは 0.1.1 から不変。**Codex 側の再信頼は不要**（見込み。この版で実測する）
- 導入先の更新は `claude plugin update` を aidd-core / aidd-vkumai の 2 本とも回す（0.1.1 で実測した制約）

## 0.1.1（2026-09-28）

- 版上げ配布の初回実施（`docs/plugin/RELEASE.md` §7 の未実測を潰すため）。
  **marketplace リポジトリに配った 0.1.0 は 2026-09-06 の生成物のまま**で、下記「0.1.0」節の
  2026-09-07 以降の変更（検査の同梱・`aidd-check.sh`・proposer・wrapper 撤去・生成器修正）は
  中心リポジトリと手元の clone にしか無かった。0.1.1 はそれらをすべて含む
- `aidd-codex` の hook 定義（`hooks/hooks.json`）は段階 (5) で実測した形から不変。**Codex 側の再信頼は不要**
  （RELEASE.md §4.3。ただし marketplace 名が検証用の `aidd-codex-configured` から `aidd-plugins` に変わるので、
  検証用の個人設定を残している環境では信頼の鍵が変わり、初回のみ信頼が要る）
- `aidd-codex` が marketplace リポジトリ `aidd-plugins` に初めて載る（Codex 用カタログ
  `.agents/plugins/` 配下）

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
- **2026-09-12: 導入先の入口を wrapper Workflow からセッションの直接呼び出しへ変えた。** ひな形の
  wrapper は `aidd-vkumai:aidd-phase1-router` を呼び、その router がさらに `aidd-phase1` を呼ぶので
  **入れ子が 2 段**になり、エージェントを 1 体も起動しないまま失敗していた（Claude Code 2.1.258 で実測）。
  中心リポジトリは router を直接呼ぶので 1 段に収まる——**配布物の形でだけ壊れていた**。
  ひな形から Workflow を削り、MIGRATION.md と README を直接呼び出しへ直した。連鎖そのものは
  `scripts/check-workflow-nesting.test.sh` が門にする（型は C-053、実例は E-085）
- **2026-09-12: 配った検査に「何を見るか」の宣言と、導入先から回す入口を付けた。** それまで
  入口が無く、配った 92 本は**導入先ではなくプラグイン自身**を見ていた（導入先に置いた違反 4 件のうち
  反応したのは 1 本だけ、と実測）。層（self / consumer / both）を `plugin-layout.json` の `checkScopes` で
  宣言し、生成物へ `scripts/lib/check-scopes.json` として配る。入口は `aidd-check.sh`
  （aidd-core の `bin/` に入り PATH に足される）。
  宣言が無い検査は `scripts/check-plugin-check-coverage.test.sh` が落とす。
  あわせて `consumer` の 4 本（shell の 2 本・スキル本文の長さ・Codex 設定の分離）の根を
  `CLAUDE_PROJECT_DIR` 優先へ変え、**小さい導入先で意味の無い赤が出ない**ようにした
  （空振り防止の下限を 20 本 → 0 本、`.codex/` が無ければ対象なしで黙る）
- **2026-09-28: 版を上げて配り直せる形に生成器を直した（`docs/plugin/RELEASE.md` §0）。**
  `--marketplace` で Codex 用カタログ `.agents/plugins/marketplace.json` も生成し、`aidd-codex` を
  同じ marketplace リポジトリから配れるようにした（それまで Claude 用の 2 本しか載っていなかった）。
  Claude 用カタログのエントリから `version` を外した（公式は「plugin.json とエントリの両方に書くな」。
  正本は plugin.json）。層の表の版 3 箇所（`plugins.*.version` / `codexPlugin.version`）と依存範囲が
  揃っていなければ生成しない（1 箇所だけ上げると導入先の依存解決が失敗する）。README に
  Claude / Codex それぞれの導入と更新の手順を書く。Git 越しの Codex カタログ解決は未実測（RELEASE.md §7）
