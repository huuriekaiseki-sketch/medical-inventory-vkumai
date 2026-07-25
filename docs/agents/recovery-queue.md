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
- `workflow-interrupted`: `scripts/check-workflow-interruption.sh`（SessionStart hook）が
  登録する。Workflow中断からの`resumeFromRunId`再開（[`workflow-resume-runbook.md`](./workflow-resume-runbook.md)）
  が復旧内容。詳細は下記「Workflow中断→resumeFromRunId再開（issue #534で実装）」参照

## Workflow中断→resumeFromRunId再開（issue #534で実装）

issue #523の起票時点では「復旧手順が既に明文化されている2種」として本typeも第一弾の対象に
含める想定だったが、「Workflowが中断された」ことを機械的に検知する信頼できる手段が当時
無かったため見送っていた（経緯は本ファイルのgit履歴参照）。issue #534で実際にWorkflow実行を
中断させる実機観測を行い、以下の事実を確認した上で実装した。

**実機観測で確認できた事実（2026-07-25）:**
- TaskStopで明示的にWorkflow実行を中断すると、`<transcript配置ディレクトリ>/<session_id>/
  workflows/wf_*.json` の`status`フィールドは確実に`"killed"`になる（`result: null`、
  `error: "Error: Workflow aborted..."`も併記される）
- 正常完了時は`status: "completed"`。両者は明確に区別できる

**判定ロジック（`scripts/check-workflow-interruption.sh`）:**
1. `status === "killed"` は実機確認済みの確実な信号として即座に対象とする
2. `status !== "completed"` かつファイルの更新時刻が閾値（既定4時間、
   `WORKFLOW_INTERRUPTION_STALE_HOURS`で変更可）より古い場合も対象とする
   （`check-local-main-freshness.sh`等と同型の「厳密ではないが安全側」staleness近似）
3. 既に登録済みの`runId`は`.aidd/.workflow-interruption-seen`（直近500件のみ保持し
   無制限肥大化を防ぐ）で重複登録を防ぐ

**未検証のまま残る既知の限界:**
- 本来ターゲットにしたい失敗モード（セッション自体がクラッシュ・タイムアウト等で異常終了し
  Workflowが取り残されるケース）は、TaskStop経由の`abort()`コードパスを通らない可能性が高く、
  `"killed"`が書き込まれないまま放置される懸念が残る。セッションを実際にクラッシュさせて
  検証することは安全に行えないため未検証のまま
- 判定ロジック2.（staleness近似）が前提とする「`wf_*.json`のmtimeは実行中も更新され続ける」
  という仮定自体、部分的にしか実機確認できていない（issue #534 PRレビュー指摘）。中断直後
  （起動から2.2秒後）に読んだファイルが1件目の`agent()`呼び出しの`"start"`状態を反映して
  いたことは確認できた（起動時に1回書いて放置、ではない）が、1回の`agent()`呼び出し自体が
  長時間（Fable 5は1ターンが数分〜数時間になりうる、issue #498参照）かかる間もmtimeが
  更新され続けるかは確認できていない。監視用の別プロセスを起動する頃には検証対象のprobe
  Workflowが先に完了してしまい、進行中スナップショットを捕捉できなかった
- 上記2点の未検証を踏まえ、閾値は安全側に長め（既定4時間）に設定した。より確実な検証が
  できるまでは、正当に長時間実行中のWorkflowを誤検知するリスクが完全には排除できていない
  （このリポジトリの一貫した方針どおり不確かな検知能力を実装済みと詐称しない）

**fault injection実測（issue #534、2026-07-25）:** 実際にWorkflowを起動しTaskStopで中断させ、
`check-workflow-interruption.sh`実行→`.aidd/recovery-queue.jsonl`への登録→
`check-recovery-queue.sh`によるsystemMessage表示、まで一巡することを確認した。同時に、
正常完了した2件のWorkflow実行が誤って対象にならないことも確認した。

## 安全上の制約

- 停止①②（仕様レビュー・構造化レビュー）を自動復旧でスキップしない
- サーキットブレーカー（`/goal`・budgetガード）を復旧ループが迂回しない
- 復旧キュー自体の記録漏れ・処理漏れの検知手段は今回未実装のまま
  （issue #339の原則どおり、この限界を明記しておく。`status: "surfaced"`から
  `"resolved"`への遷移は自動化されておらず、対応後は手動でキューから該当行を削除する運用）
