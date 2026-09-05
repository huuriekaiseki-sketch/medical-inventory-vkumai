# 導入先アダプターのひな形

プラグインが同梱できないもの（設定・パス限定ルール・CLAUDE.md・wrapper Workflow）を導入先に置くための
ひな形。各ファイルをリポジトリ直下（`.claude/` はそのまま）へコピーし、値を埋める。

| ファイル | 役割 |
|---|---|
| `aidd.config.json` | 高リスクの語・パス、読み取り専用ロール、検査コマンド、追記先 docs。既定値に足すだけで消せない |
| `CLAUDE.md` | フローの骨格と Workflow の呼び方（修飾名） |
| `.claude/workflows/aidd-phase1-router.js` | `aidd.config.json` の `risk` を `args.riskConfig` として渡す wrapper（Workflow は導入先のファイルを読めないため、呼び出し側が渡す） |
| `.claude/rules/` | パス限定ルール（例は含めない。導入先のスタックに合わせて書く） |
