# 導入先アダプターのひな形

プラグインが同梱できないもの（設定・パス限定ルール・CLAUDE.md・wrapper Workflow）を導入先に置くための
ひな形。各ファイルをリポジトリ直下（`.claude/` はそのまま）へコピーし、値を埋める。

| ファイル | 置き場 | 役割 |
|---|---|---|
| `aidd.config.json` | リポジトリ直下 | 高リスクの語・パス、読み取り専用ロール、検査コマンド、追記先 docs、入口が返してよいエラー型。既定値に足すだけで消せない |
| `CLAUDE.md` | リポジトリ直下 | フローの骨格と Workflow の呼び方（修飾名） |
| `catalog-registry.json` | `scripts/lib/` | ルールブックの登録簿。**ルールブックはリポジトリごとに増える**ので登録簿は導入先のもの（プラグインは配らない＝上書きで消えない）。エンジンと雛形生成はプラグインが配る |
| `rule-guard-registry.json` | `scripts/lib/` | 「このルールはこの検査が守る」の対応表。守る検査が無いルールを見つけるために使う |
| `table-duplicates-registry.json` | `scripts/lib/` | 重複を見る表とその鍵の列。`.gitattributes` の union 対象と食い違うと落ちる |
| `roadmap-registry.json` | `scripts/lib/` | 積んだ作業と証拠の登録簿。証拠が古いまま放置されていないかを見る |
| `check-design-pitfalls.md` | `docs/agents/` | 検査を設計するときの間違え方（C-xxx）。**型はどのリポジトリでも同じなので配るが、実例と守るテストは自分のもの**。踏んだら日付つきで 1 行足す |

**`.claude/rules/` はひな形に含めない。** パス限定ルールは導入先のスタックに依存するので、
自分で `.claude/rules/<名前>.md` を作り、frontmatter の `paths` で発火条件を書く
（例は置かない——写して使われると、そのリポジトリに無いパスを指したまま腐るため）。

## `.gitignore` に足すもの

プラグインを入れて動かすと、導入先に次の 2 つが増える（2026-09-12 に導入先を模した
リポジトリで実測。これ以外は増えない）:

```
.aidd/
logs/
```

`.aidd/` は実行中の状態（run-manifest・警告を出したかの記録）、`logs/` は観測記録
（進捗・骨格・journal）。**どちらも実行ごとに変わる作業ファイルなので追跡しない。**
追跡すると、セッションのたびに差分が出てレビューの邪魔になる。

**Workflow は置かない。** 入口は `aidd-vkumai:aidd-phase1-router` を**セッションから直接**呼び、
`aidd.config.json` の `risk` を `args.riskConfig` として渡す（Workflow は導入先のファイルを読めないので、
呼ぶ側が渡す）。

```
Workflow({ name: 'aidd-vkumai:aidd-phase1-router', args: { taskDescription, changedFiles, riskConfig } })
```

wrapper Workflow を置くと wrapper → router → phase1 で**入れ子が 2 段**になり、エージェントを 1 体も
起動しないまま失敗する（2026-09-12 実測）。同じ形に戻らないよう
`scripts/check-workflow-nesting.test.sh` が連鎖そのものを門にしている。
