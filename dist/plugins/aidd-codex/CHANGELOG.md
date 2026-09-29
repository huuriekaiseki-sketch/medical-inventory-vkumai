# AIDD Codex: 変更履歴

## 未リリース（次の版で配る）

- `check-skip-marker-write.sh` が Codex のファイル編集（`apply_patch`）を読むようにした。0.1.3 までは
  ファイル編集で `.claude/.verify-state/*.skip` を作っても止まらなかった（仕様書
  `docs/specs/codex-hook-parity/01-apply-patch.md`）。
- hook 定義（`hooks/hooks.json`）は不変。**再信頼不要**。
- Codex 実機での発火は未検証。

## 0.1.3（2026-09-28）

- 中身は 0.1.2 と同じ（差は文書のみ）。hook 定義・スクリプト不変。**再信頼不要**。
- 同じ marketplace に vkumai 固有の `aidd-codex-vkumai` が初めて載る（このプラグインとは別に導入する）。

## 0.1.2（2026-09-28）

- 版を変えた更新の実測用。hook 定義・スクリプトは 0.1.1 から不変（差は文書のみ）。
- 配布後: vkumai 固有の hook 4 本は別プラグイン `aidd-codex-vkumai` で配ることにした（このプラグインの中身は変わらない）。
- 導入済み環境では `codex plugin marketplace upgrade aidd-plugins` **だけで** 0.1.2 に入れ替わり、
  `/hooks` の信頼 4 件は維持され、再信頼なしに SessionStart の hook が発火した（2026-09-28 実測。
  evidence 2026-09-28-version-update-verify.md）。remove / add は不要。

## 0.1.1（2026-09-28）

- 版上げ配布の初回実施。marketplace リポジトリ `aidd-plugins` に初めて載る（Codex 用カタログ経由）。
- hook 定義（`hooks/hooks.json`）とスクリプト本体は 0.1.0（段階 (5) で実測した生成物）から不変。
  同じ marketplace 名で導入していれば**再信頼は不要**。marketplace 名が変わると信頼の鍵が変わり初回のみ信頼が要る。
- manifest は 0.1.0 と同じ `.codex-plugin/plugin.json` 形式（ルート `plugin.json` は出さない）。

## 0.1.0（2026-09-26）

- `.codex/hooks.json` から共通 hook 4 本と判定本体を生成。
- portable `plugin.json`、環境診断 doctor、doctor スキル、対応状況と既知の制約を追加。
- これらの配布物は中心リポジトリの正本から生成し、生成先を直接編集しない。
