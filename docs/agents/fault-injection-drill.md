# Fault Injection訓練（issue #395）

`.claude/workflows/aidd-phase2.js`のdeny-by-defaultゲート（Spec Check / Manifest Check）が、
プロンプト文言変更の影響を受けても**実際に**`blocked`を返すことを、本物のWorkflow実行を通じて
実測するためのランブック。

## 背景

`aidd-phase2.js`のSpec Check/Manifest Checkは実際には「エージェントへの自然言語プロンプト指示」
として実行されており、`.claude/workflows/lib/`配下の純粋関数ミラー（`quality-gate.js`の
`shouldBlock`等）とそのテストは、このプロンプトが変わっても自動追従しない。つまり単体テストが
green でも、実行パスの本体（プロンプト駆動のエージェント）が本当にblockedを返すとは限らない
（issue #348と同種のギャップ）。詳細な経緯は
[`docs/specs/issue-395-fault-injection-drill.md`](../specs/issue-395-fault-injection-drill.md)
のPart 1を参照。

## 実施タイミング

1. `.claude/workflows/aidd-phase2.js`のSpec Check/Manifest Check関連プロンプトを変更したとき
2. 四半期に1回の定期訓練として（下記「次回実施予定日」参照）

## 対象シナリオ（4種）

| シナリオ | fixture | 期待される`blockedAt` |
|---|---|---|
| SPEC.md欠如 | `.claude/workflows/__fixtures__/fault-injection/missing-spec/`（README.mdのみ、SPEC.md自体は無い） | `Spec Check` |
| Run Manifest欠如 | `.claude/workflows/__fixtures__/fault-injection/missing-manifest/SPEC.md`（有効なSPEC.mdのみ） | `Manifest Check` |
| 承認記録欠如 | `.claude/workflows/__fixtures__/fault-injection/missing-approval/`（SPEC.md + specHashはあるがapprovalが無いrun-manifest.json） | `Manifest Check` |
| specHash改ざん | `.claude/workflows/__fixtures__/fault-injection/tampered-spechash/`（SPEC.mdの実際の内容とrun-manifest.jsonのspecHashが最初から不一致） | `Manifest Check` |

## 実行手順

各シナリオごとに以下を行う。

1. **setup**: `bash scripts/aidd-fault-injection-setup.sh <scenario>` を実行する。
   `<scenario>`は`missing-spec` / `missing-manifest` / `missing-approval` / `tampered-spechash`のいずれか。
   - 実在の`.aidd/run-manifest.json`があれば自動で`.aidd/run-manifest.json.bak`にバックアップされる。
   - 標準出力に、次のWorkflow呼び出しで使う`specPath`が1行で表示される。
2. **Workflow呼び出し**: 表示された`specPath`を使って以下を実行する。
   ```
   Workflow({ name: "aidd-phase2", args: { specPath: "<表示されたパス>" } })
   ```
3. **期待値確認**: 返ってきた`result.blocked === true`かつ`result.blockedAt`が上表の値と一致するか確認する。
4. **teardown**: `bash scripts/aidd-fault-injection-teardown.sh` を実行する。
   `.aidd/run-manifest.json.bak`があれば復元され、無ければ`.aidd/run-manifest.json`が削除される
   （訓練前の状態に必ず戻る）。

4シナリオすべて実施したら、下記「実施記録」欄に結果を追記する。

## 不一致が出た場合の対応（必須・例外なし）

**4シナリオのうち1つでも`blockedAt`が期待値と一致しない場合、その場でGitHub Issueを作成する。
これは必須であり任意ではない。** `docs/agents/decisions.md`への記録に留めて後回しにすることは
禁止する。理由: この不一致は「設計判断の記録」ではなく「deny-by-defaultゲートに実際に穴が
開いている」という確定した実害の発見であり、issue #348と同種のパターンだからである
（詳細は[SPECのPart 1「判断が必要な点」3.](../specs/issue-395-fault-injection-drill.md)参照）。

Issue作成後、この実施記録欄に対応Issue番号を記入する。

## 実施記録

| 実施日 | 実施者 | SPEC.md欠如 | Run Manifest欠如 | 承認記録欠如 | specHash改ざん | 不一致時のIssue番号 |
|---|---|---|---|---|---|---|
| 2026-07-16 | implementer (Claude Sonnet 5) | 未実測（fixture/スクリプト動作のみ確認） | 未実測（同左） | 未実測（同左） | 未実測（同左） | - |
| 2026-07-16 | orchestrator (Claude Sonnet 5、Workflowツール経由で4シナリオ全て実測完了) | **不一致**: 期待`Spec Check`、実際`Manifest Check`（後述の原因により） | 一致（`Manifest Check`、正しい理由） | 一致（`Manifest Check`、正しい理由。フィクスチャ固有の詳細も正確に言及） | 一致（`Manifest Check`、正しい理由。正しいファイルの実ハッシュ`69ce73d4...`で比較） | **#399** |
| 2026-07-16 | orchestrator（PR #402マージ後の再検証、SPEC.md欠如シナリオのみ再実施） | **不一致（継続）**: 期待`Spec Check`、実際`Manifest Check`。ただし原因はPR #402が対処した非対称バグとは別物と判明（後述） | 未実施 | 未実施 | 未実施 | **#399（追記コメント）** |

> **注記（2026-07-16、1回目=implementer実施分）**: fixture・setup/teardownスクリプトの動作
> （`.aidd/run-manifest.json`の上書き・バックアップ・復元・`specPath`出力・未知シナリオでの
> `exit 1`）は4シナリオすべて実機で確認済み。ただし実際の`Workflow({ name: "aidd-phase2", ... })`
> 呼び出し（本物のサブエージェント実行を伴う）は当時のセッションのツール制約上、実行できて
> いなかった。

> **注記（2026-07-16、2回目=orchestrator実施分、4シナリオ全て完了）**: 生のtranscript
> （`agent-*.jsonl`）を直接確認した結果、当初の推測（「Spec Checkエージェントが指示を無視して
> 別ファイルを読んだ」）は不正確だったことが判明した。実際には、3回（SPEC.md欠如・Run Manifest
> 欠如・承認記録欠如の各シナリオ）とも、Spec Checkへ送られた生のプロンプト文字列は文字通り
> `"Readツールで SPEC.md が存在し読み込めるか確認してください。"`であり、`${specPath}`が
> 指定した値ではなく常にデフォルト値`'SPEC.md'`のまま埋め込まれていた。エージェントは指示に
> 忠実だった。一方、Manifest Checkのstep4（`${specPath}`の内容からハッシュを計算する部分）は
> 2回（issue #395本体のPhase 2実装時・今回のspecHash改ざんシナリオ）とも正しく指定された
> `specPath`のファイルの実ハッシュを計算していた。同一スクリプト内の同じ`const specPath`を
> 参照しているはずなのに、**スクリプト内で最初に呼ばれるagent()呼び出し（Spec Check）だけが
> 一貫して`args.specPath`を反映せず、2番目のagent()呼び出し（Manifest Check）は正しく反映する**
> という非対称な挙動が、5回の独立した実行すべてで再現した。詳細と再発防止の推奨対応は
> issue #399のコメント参照。
>
> **4シナリオ中3シナリオ（Run Manifest欠如・承認記録欠如・specHash改ざん）はManifest Check
> ゲートが期待通り正しい理由でblockedを返すことを実測で確認できた。** Spec Checkゲートのみ、
> 上記の理由で「specPathで指定した仕様書が存在しない」という異常系を正しく検知できていない。
> 「4シナリオ全て一致すれば訓練成功」という当初の完了条件には到達していないが、これは
> issue #395が本来検知しようとしていた種類の実害そのものであり、訓練としては成功している
> （不一致を見つけて即issue化するというSPEC決定事項通りの運用ができた）。

> **注記（2026-07-16、3回目=PR #402マージ後の再検証）**: PR #402が追加した「実際にReadした絶対パス
> (`actualPath`)の自己申告 + 指定specPathとの機械照合」を検証するため、SPEC.md欠如シナリオを再実行
> したところ、期待通りの`blockedAt: "Spec Check"`にはならず、再び`Manifest Check`でblockedになった。
> 生transcript（`agent-a3f097c0d8d3c2817.jsonl`）を確認すると、Spec Checkエージェントへ送られた
> 生のプロンプトは今回も文字通り`"Readツールで SPEC.md が存在し..."`であり、`${specPath}`が
> デフォルト値`'SPEC.md'`のままだった。加えて今回はManifest Check側（`agent-a17013fba7940dccb.jsonl`）
> のプロンプトも`"...SPEC.md の現在の内容から..."`とデフォルト値になっていた（ただしstep1の
> manifest不在で早期blockedしたためstep4は未到達、影響は未検証）。
>
> 切り分けのため、`aidd-phase2.js`を経由しない最小の独立ワークフロー（`args`をログ出力するだけの
> スクリプト）を`Workflow({ script: ..., args: { specPath: "..." } })`で実行したところ、
> `args`自体が期待通りに渡っておらず、`specPath`が終始デフォルト値`'SPEC.md'`だった
> （`{"specPath":"SPEC.md","result":{"detail":"SPEC.md"}}`）。
>
> これは、issue #399が当初特定した「スクリプト内で最初に呼ばれるagent()呼び出しだけが
> `args.specPath`を反映しない」という**非対称バグ**とは別の、より根本的な症状である可能性が高い
> （今回はSpec Check・Manifest Check双方、さらに`aidd-phase2.js`を介さない最小スクリプトの
> `args`受け渡し自体が機能していなかった）。つまり**今回の再検証では、PR #402の機械照合ロジック
> 自体が正しく動くかどうかを検証できていない**（`specPath`変数が終始デフォルト値のままだったため、
> 照合ロジックの分岐に到達する条件＝「actualPathが指定specPathと不一致」という前提が
> そもそも成立しなかった）。このセッション固有の環境要因（Workflowツールのバージョン・実行環境等）
> の可能性があるため、別セッション・別環境での再検証を推奨する。詳細はissue #399に追記コメント。

## 次回実施予定日

2026-10-16（四半期後の目安。日付自体は手動で書き換える。ただし期限超過の検知は
`scripts/check-fault-injection-drill-staleness.sh`がSessionStart hookとして機械化済み
（issue #443・`.claude/settings.json`のSessionStart配列に配線）で、期限を過ぎてもこのファイルが
更新されなければ警告が出る）
