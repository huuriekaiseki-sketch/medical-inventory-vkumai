# 導入先アダプターのひな形

プラグインが同梱できないもの（設定・パス限定ルール・CLAUDE.md・wrapper Workflow）を導入先に置くための
ひな形。各ファイルをリポジトリ直下（`.claude/` はそのまま）へコピーし、値を埋める。

| ファイル | 役割 |
|---|---|
| `aidd.config.json` | 高リスクの語・パス、読み取り専用ロール、検査コマンド、追記先 docs。既定値に足すだけで消せない |
| `catalog-registry.json` | ルールブックの登録簿。`scripts/lib/catalog-registry.json` へ置く。**ルールブックはリポジトリごとに増える**ので登録簿は導入先のもの（プラグインは配らない＝上書きで消えない）。エンジンと雛形生成はプラグインが配る |
| `CLAUDE.md` | フローの骨格と Workflow の呼び方（修飾名） |
| `.claude/rules/` | パス限定ルール（例は含めない。導入先のスタックに合わせて書く） |

**Workflow は置かない。** 入口は `aidd-vkumai:aidd-phase1-router` を**セッションから直接**呼び、
`aidd.config.json` の `risk` を `args.riskConfig` として渡す（Workflow は導入先のファイルを読めないので、
呼ぶ側が渡す）。

```
Workflow({ name: 'aidd-vkumai:aidd-phase1-router', args: { taskDescription, changedFiles, riskConfig } })
```

wrapper Workflow を置くと wrapper → router → phase1 で**入れ子が 2 段**になり、エージェントを 1 体も
起動しないまま失敗する（2026-09-12 実測）。同じ形に戻らないよう
`scripts/check-workflow-nesting.test.sh` が連鎖そのものを門にしている。
