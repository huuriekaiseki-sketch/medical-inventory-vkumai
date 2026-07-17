# Workflow resumeFromRunIdによる再開手順（issue #442）

AIDDフロー（`aidd-phase1` / `aidd-1-1-deep-task` / `aidd-phase2`等）の実行が途中で
失敗・中断したとき、`resumeFromRunId`を使って完了済みの`agent()`呼び出しをキャッシュから
即時復元し、未完了分のみ再実行するための手順。

## 背景

Workflowツールは実行のたびに`Run ID`とスクリプトファイルのパスを返す。何も指定せず
同じ内容で再実行すると、既に完了していた`agent()`呼び出し分のコスト（トークン・時間）が
まるごと無駄になる。`resumeFromRunId`を使えば、`(prompt, opts)`が変わっていない
`agent()`呼び出しはキャッシュから即座に返り、変更・未実行の呼び出しのみ実際に走る。

## いつ使うか

- Workflow実行がエラー・セッション利用上限・タイムアウト等で中断したとき
- 実行結果を見てポストプロセス（戻り値の集計・ログ出力部分）だけ直したく、
  エージェント呼び出し自体はやり直したくないとき
- スクリプトの一部（後段のstage）だけを修正して再実行したいとき

## 使い方

1. 通常のWorkflow呼び出し結果には以下が含まれる。これを控えておく。
   - `Run ID`（例: `wf_eaaedea7-16c`）
   - `Script file`のパス（例:
     `~/.claude/projects/<project>/<session>/workflows/scripts/<name>-wf_xxx.js`）
2. スクリプトを直さず、そのまま再開する場合:
   ```
   Workflow({ scriptPath: "<Script fileのパス>", resumeFromRunId: "<Run ID>" })
   ```
3. スクリプトの一部を直してから再開する場合:
   - Write/Editで`Script file`のパスを直接編集する（`script`引数で再送しない — 直接編集が前提）
   - 編集後、手順2と同じ呼び出しを行う
   - 編集していない箇所（＝先頭から最初の差分行より前の`agent()`呼び出し）はキャッシュから返る。
     最初に変更・追加された`agent()`呼び出しと、それ以降はすべて実際に再実行される

## 注意点

- **`(prompt, opts)`が完全一致した`agent()`呼び出しのみキャッシュヒットする。** ラベルや
  プロンプト文言を1文字でも変えると、その呼び出し以降は再実行対象になる
- **同一セッションのみ有効**（Workflowツールの説明に明記）。セッションをまたいで
  `resumeFromRunId`を使うことはできない
- **キャッシュされた結果が空のことがある。** 「戻り値が空/想定外」の場合、まずキャッシュを
  疑って再実行するのではなく、`journal.jsonl`（`Per-agent results`として案内されるパス）を
  読んで、そのagent()が実際に何を返したかを確認すること
- 実行中のRunを止めてから編集・再開したい場合は、先にTaskStopで止める（Runが動いたまま
  スクリプトを編集しても、動いている実行には反映されない）

## 実例（issue #442のPhase 1調査で実際に得られた形式）

```
Workflow launched in background. Task ID: wowa5mhrs
Transcript dir: ~/.claude/projects/<project>/<session>/subagents/workflows/wf_d1078b0d-976
Script file: ~/.claude/projects/<project>/<session>/workflows/scripts/aidd-phase1-wf_d1078b0d-976.js
Run ID: wf_d1078b0d-976
To resume after editing the script: Workflow({scriptPath: "<Script fileのパス>", resumeFromRunId: "wf_d1078b0d-976"})
```

このセッションでは実際に「ルーターが誤判定してdeep-taskが走った」→「ルーターをバイパスして
`aidd-phase1`を新規に呼び直した」という対応を取ったため、`resumeFromRunId`は使わなかった
（誤判定の結果自体が今回のタスクと無関係で、再開しても意味が無かったため）。次回、
「正しいルートで実行していたが途中でセッション利用上限に達した」等の場合に本手順を使うこと。
