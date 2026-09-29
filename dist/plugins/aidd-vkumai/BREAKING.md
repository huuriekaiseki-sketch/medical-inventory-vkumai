# 互換性を壊す変更の一覧（7 項目の 4）

何を「破壊的」とみなすか（中心方針: 形式・列・ID 規約が鍵）:

- `aidd.config.json` のキー名・型の変更、既定値の削除
- hook の stdin / stdout 契約の変更（`permissionDecision` の意味、systemMessage の有無）
- ログ（`logs/*.jsonl`）の列名・値域の変更（canonical event の形）
- agent / workflow の名前変更（修飾名が変わる）、`bin/` のスクリプト名変更
- 引き継ぎメモ 04 表の列・4 値、約束カタログの列・ID 規約
- 層の移動（アダプター → 共通、またはその逆）。呼び出し側の修飾名が変わるため

| 版 | 変更 | 移行 |
|---|---|---|
| 0.1.0 | （初版。手コピー v0 からの差は MIGRATION.md） | — |
| 0.1.1 | 破壊的変更なし（中身は 0.1.0 と同じ。marketplace のエントリから `version` を外したが、正本の plugin.json は変わらない） | 不要 |
| 0.1.2 | 破壊的変更なし（差は文書のみ） | 不要 |
| 0.1.3 | 破壊的変更なし（`aidd-codex-vkumai` の追加。既存 3 本の差は文書のみ） | 不要（新プラグインは任意で導入） |
| 0.1.4 | 破壊的変更なし（hook の stdin / stdout の形・`permissionDecision` の意味・hook 定義は不変）。ただし**止める範囲が変わる**: 前置き付きのコマンドと Codex のファイル編集を止めるようになり、skip マーカーを読むだけの操作と `psql` の版確認だけは止めなくなった。Codex 用ラッパーは判定本体が欠けると exit 2 で全部止める | 不要。Codex の実機確認に `psql --version` を使っていた手順は `psql -c "select 1"` などへ変える（RELEASE.md） |
