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
