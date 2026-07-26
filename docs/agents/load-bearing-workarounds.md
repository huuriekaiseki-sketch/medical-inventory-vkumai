# ツール制約回避のload-bearing workaround棚卸し

[`common.md`](./common.md) から分離した参照ドキュメント（issue #542。`/doctor`実行結果を踏まえ、
参照頻度が低く常時ロードする必要のないブロックをcommon.mdから切り出す方針。issue #445の
path-scoped rules化とは異なり、特定パスに紐づかない内容のため別ファイル化＋ポインタ参照とした）。

2026-07-16のmentor設計レビューで、AIDDフレームワークの相当部分がツール（Workflow DSL /
`claude -p`）の制約・不具合への回避策でできていることが確認された（issue #413）。各回避策は
decisions.md等に「なぜ」が記録されガードも付いているが、**Claude Code側の更新で回避策の前提が
壊れると、検知網自体が静かに全滅しうる**（回避策 = 検知網の土台、というメタ構造のため）。
ツール本体を更新したとき、またはeval/ワークフロー実行が理由不明に失敗し始めたときは、まず
この表を確認すること。

| 回避策 | 場所 | 前提とするツール挙動 | 解除条件／破損条件 | smoke test |
|---|---|---|---|---|
| args `typeof === 'string'` → `JSON.parse`防御 | `.claude/workflows/aidd-phase1-router.js` / `aidd-phase1.js` / `aidd-phase2.js` / `aidd-1-1-deep-task.js` / `aidd-session-report.js`（Workflow DSLスクリプト5本すべてに複製。正本: `.claude/workflows/lib/resolve-workflow-args.js`） | Workflowツールがargsをobjectで渡してもstringで届く不具合（[`decisions/aidd-pipeline.md`](./decisions/aidd-pipeline.md#なぜaidd-phase1-routerjsでargsをjsonparseする防御コードを入れたか)） | **解除**: ツール側がargsを常にobjectで渡すよう修正されれば、この分岐に到達しなくなるだけで副作用なし（前方互換設計のため削除は任意）。**破損**: このガード自体が壊れることは想定しにくい（`typeof`判定のみのため）。ただし5箇所に複製されておりsync testは無い（1行のみのため意図的に省略、`resolve-workflow-args.js`のコメント参照） | `resolve-workflow-args.test.js`（npm test内。ただしDSL側5箇所との一致自体は検証しない） |
| `--setting-sources ""` + `--agents`フラグでのagent定義注入 | `scripts/lib/build-eval-agent-json.mjs` | `--setting-sources ""`が`.claude/agents/*.md`探索も無効化する挙動 | **解除**: `--setting-sources`が`.claude/agents/`探索のみを無効化しないよう修正されれば不要。**破損**: `--agents`フラグのJSON構造・優先順位が変更されると`--agent implementer`解決自体が失敗し、evalの実エージェント呼び出しが全滅する（[`observability-internals.md`](./observability-internals.md#aiddワークフロープロンプトのevalissue-391)「AIDDワークフロープロンプトのeval」に既述のload-bearing箇所） | JSON出力形式は`build-eval-agent-json.test.mjs`（npm test内）で検証済み。**ただし実際に`claude -p --agents ... --agent <type>`でagent解決できるかどうかの専用smoke testは無い**（`claude -p`の実呼び出しが必要でCI化見送り済みのため、issue #391と同じ判断。`npm run eval:workflows db-impl`を手動実行した際に暗黙的に再検証されるのみ） |
| プロンプト正本の切り出し＋インライン複製＋sync test | `.claude/workflows/lib/prompts/db-impl.js` ⇔ `aidd-phase2.js`、`.claude/workflows/lib/spec-check.js` / `manifest-check.js` ⇔ `aidd-phase2.js`、`.claude/workflows/lib/prompts/sweep.js` ⇔ `aidd-phase1.js` / `aidd-1-1-deep-task.js` | Workflow DSLがfilesystem API不可でローカルモジュールをrequire/importできない制約 | **解除**: Workflow DSLがローカルモジュールをimportできるようになれば、インライン複製自体が不要になり正本を直接importする形に変えられる。**破損**: プロンプト文言変更時にインライン複製側を追従させ忘れると乖離する（これを検知するのがsync testの目的そのもの） | `workflow-prompt-sync.test.js` / `sweep-prompt-sync.test.js`（npm test内） |
| TRI/RISK・メタ改修判定ロジックの切り出し＋インライン複製＋sync test | `.claude/workflows/lib/router-risk.js` ⇔ `aidd-phase1-router.js`（issue #457） | 同上（Workflow DSL importの制約）。プロンプト（テンプレートリテラル）ではなく`const`配列・`function`宣言の複製のため、`extract-declaration.js`という別の抽出ユーティリティを使う | **解除**: 同上。**破損**: `classifyRoute`等の関数・定数配列を変更したのに`aidd-phase1-router.js`側のインライン複製を追従させ忘れると乖離する | `router-risk-sync.test.js`（npm test内） |
| eval fixture manifestとaidd-phase2.js内スキーマ定義の同期 | `scripts/eval-fixtures/db-impl/manifest.json` ⇔ `aidd-phase2.js`内のスキーマ定義 | 同上（Workflow DSL importの制約） | **解除**: 同上。**破損**: スキーマ定義がドリフトすると、evalが実際のプロンプトと異なるスキーマでテストしてしまい気づかれない | `eval-fixture-manifest-schema-sync.test.js`（npm test内） |
| 進捗・観測ログの自然言語指示依存 | `scripts/log-agent-progress.sh` / `scripts/log-loop-observability.sh`呼び出し | Workflow DSLがfilesystem API不可で、ワークフロー本体から機械的にログを書き込めない制約 | **解除**: 同上（importまたは直接fs書き込みが可能になれば、本体側から機械的に記録できる設計に変更可能）。**破損**: 元々「壊れる」ものではなく「そもそも書かれない」リスクが常態（自然言語指示依存のため） | 記録漏れの事後検知（`check-loop-observability-gap.sh` / `check-agent-progress-gap.sh`）があり、その実行はStop hook（`scripts/check-gap-check-state.sh`、issue #488）で機械トリガー化済み。ただしbefore/expectedのstateファイル記録（`scripts/record-gap-check-state.sh`）自体はオーケストレーターの自己申告のまま残る |
| Reviewリトライ履歴のプロンプト引き渡し | `.claude/workflows/lib/review-retry-history.js` ⇔ `aidd-phase2.js`（issue #490） | Workflow DSLに「サブタスク間でコンテキストを保持する長寿命のサブエージェント」を起動するAPIが無い制約（Fable 5公式ガイドが推奨する形が使えない） | **解除**: Workflow DSLがエージェント継続APIを持つようになれば、履歴をプロンプト文字列で毎回引き渡す代わりに長寿命サブエージェントへ置き換えられる。**破損**: `buildRetryHistorySection`の変更時に`aidd-phase2.js`側のインライン複製を追従させ忘れると乖離する | `review-retry-history-sync.test.js`（npm test内、issue #549で追加） |

**Claude Code更新時の確認手順**: (1) 上表の「smoke test」列にnpm test内のテストがある項目は
`npm test`を実行して確認する。(2) smoke testが「無い」と明記されている項目（現状は
`--setting-sources`+`--agents`の組み合わせのみ）は`npm run eval:workflows db-impl`を一度手動実行し、
4ケース中`case-1`〜`case-4`がエージェント呼び出し自体（`NG: エージェント実行が失敗しました`
以外の結果）に到達しているかを確認する。(3) 新しいload-bearing workaroundを追加した場合は、
この表に行を追加すること（issue #411の原則どおり、smoke testを機械トリガーに載せられないなら
その旨をこの表に明記し、prose追加だけで済ませない）。
