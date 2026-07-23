# 検知後の自動復旧閉ループ（recovery-queue、issue #523）

## 背景

既存の検知hook群（gap check・AIDD stats呼び忘れ・引き継ぎフォーマット等）はすべて
「検知して警告」までで、検知後の立て直しは人間がsystemMessageを読んで指示する前提だった。
長時間の自律実行（3ヶ月の反復実証を想定）では、警告→人間対応待ちがスループットの律速になる。

## 設計

- 検知hookは、警告を出すのと同時に `scripts/queue-recovery-task.sh` を呼び、
  `.aidd/recovery-queue.jsonl`（gitignore対象、`.aidd/`配下）へ1エントリ追記する
  （`{id, timestamp, type, detail, status: "pending"}`）
- 次回セッション開始時、SessionStart hook（`scripts/check-recovery-queue.sh`）が
  `status: "pending"` のエントリを読み、セッション冒頭のcontextへ注入する
  （`systemMessage`。同時に`status`を`"surfaced"`へ書き換え、同一エントリを毎セッション
  繰り返し表示しないようにする）
- 実際の復旧作業は、contextへ注入された内容を見てセッション自身が自律的に行う。
  hookスクリプト自体は復旧作業を一切実行しない

## 第一弾の対象type

- `gap-check-followup`: `scripts/check-gap-check-state.sh` がgap警告を出したときに登録される。
  対応する記録漏れの原因調査・issue化が復旧内容

## 未実装のtype（Workflow中断→resumeFromRunId再開）

issue #523の起票時点では「復旧手順が既に明文化されている2種」として、Workflow中断からの
`resumeFromRunId`再開（[`workflow-resume-runbook.md`](./workflow-resume-runbook.md)）も
第一弾の対象に含める想定だった。しかし実装検討の結果、**このPRでは見送った**。

理由: 「Workflowが中断された」ことを機械的に検知する信頼できる手段が無いため。
Workflowツールは実行ごとに `<transcript配置ディレクトリ>/<session_id>/workflows/wf_*.json`
という実行記録ファイルを生成し（issue #524調査で判明）、少なくとも正常完了時は`status`フィールドに
`"completed"`が入ることを実機で確認した。しかし、

- 中断時にこのファイルが「存在するが`status`が`"completed"`でない」状態になるのか、
  それとも「そもそもファイルが存在しない」状態になるのか、実際に中断を起こして検証していない
- 仮に前者だとしても、同一worktreeで複数セッションが並行してWorkflowを実行しているケース
  （他ワーカーが正当に実行中のもの）と、本当に中断されたケースを、ファイルの中身だけから
  確実に区別できるかが未検証

を、実際に確認しないまま「検知できる」と主張してshipすることは避けた
（このリポジトリの一貫した方針：不確かな検知能力を実装済みと詐称しない）。

## 今後この機能を拡張する場合

1. まず実際にWorkflow実行を中断させ、`wf_*.json`の実際の状態（存在有無・statusフィールドの値）を
   実機観測する
2. 観測結果をもとに、誤検知（正当に実行中のものを中断扱いする）を避けられる判定条件を設計する
3. `scripts/queue-recovery-task.sh --type workflow-interrupted` を呼ぶ新しいhook
   （SessionStart推奨。前セッションの残骸を見つけるため）を追加する
4. 復旧内容の`detail`には、対象の`runId`と`docs/agents/workflow-resume-runbook.md`への
   参照を含める

## 安全上の制約

- 停止①②（仕様レビュー・構造化レビュー）を自動復旧でスキップしない
- サーキットブレーカー（`/goal`・budgetガード）を復旧ループが迂回しない
- 復旧キュー自体の記録漏れ・処理漏れの検知手段は今回未実装のまま
  （issue #339の原則どおり、この限界を明記しておく。`status: "surfaced"`から
  `"resolved"`への遷移は自動化されておらず、対応後は手動でキューから該当行を削除する運用）
