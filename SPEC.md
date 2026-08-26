# SPEC: 月次品質ゲートサマリのpass/fail集計をjournal.jsonlベースへ移行する(Issue #642)

## Part 1 — 仕様(★人間がレビューする部分)

### 背景

- `scripts/summarize-loop-observability.sh`(月次品質ゲートサマリの主集計)は`logs/loop-observability.jsonl`という**自己申告ログ**のみを見ており、欠落期間があっても「発火ゼロ」と誤読されうる
- `scripts/lib/canonical-event.ts`の`journalAdapter`はWorkflowの`journal.jsonl`(機械記録・pass/fail/blockedを保持)を正規化済みだが、**`~/.claude/projects/.../wf_*`ディレクトリはtranscript cleanupで消える**(実測: 2026-08-22時点で3ディレクトリしか残存せず、7月以降の大量の実行履歴が既に消失)
- そのため、journalベースに集計を寄せるには、消える前に永続化する「収穫層」が前提として必要

### 方針決定

1. **収穫層(Stage 1)**: Stop hookから毎回(通知の30日間隔ゲートとは無関係に)実行し、`journalAdapter`が返すイベントを`logs/journal-harvest.jsonl`(全worktree共有の`resolve_log_dir()`配下)へ**agentId基準**で重複排除しながら追記する
   - 注: eventId基準にしない理由 — `journalAdapter`のeventIdは全wf_*ディレクトリ横断の出現順連番(`lineIndex`)を含むため、古いwf_*がtranscript cleanupで消えると同一イベントのeventIdが収穫のたびに変わり、重複排除が壊れる。agentIdはエージェント実行ごとに一意かつディレクトリの増減に影響されないため、こちらを永続キーにする
2. **集計切替(Stage 2)**: 月次サマリのagent別pass/fail集計を、収穫済み`journal-harvest.jsonl`ベースに切り替える。既存の`summarize-gate-blocked.sh`(blockedのみ集計)は新集計に統合し廃止する(同じ数値を二重表示しない)
3. **残す部分(Stage 3)**: feature別・token/costUsd集計は当面`loop-observability.jsonl`(自己申告)参照のまま残すが、月次サマリ出力に「自己申告のため欠落があり得る」旨を明記する

### 受け入れ条件

- [ ] `harvestJournalEvents()`が、同じagentIdのイベントを二重に追記しない(wf_*ディレクトリの増減後も安定。ユニットテストで検証)
- [ ] `scripts/harvest-journal-events.sh`が`resolve_log_dir()`配下の`journal-harvest.jsonl`へ収穫結果を追記する
- [ ] `gate-effectiveness-monthly-check.sh`が、30日通知ゲートの前に毎回harvestを実行する(通知が出ない回でも収穫は行われる)
- [ ] `summarizePassFailGates()`が、journal由来イベント(status: pass/fail/blocked)をagentType別に集計できる(ユニットテストで検証)
- [ ] `gate-effectiveness-monthly-check.sh`の月次サマリメッセージが、journal-harvestベースのpass/fail/blocked集計を主とし、loop-observability.jsonlベースのfeature別/コスト集計には「自己申告・欠落あり得る」旨の注記がある
- [ ] `scripts/summarize-gate-blocked.sh`は新集計に統合され、重複した出力が残らない
- [ ] 既存の`npm test`・`npm run lint`が全て通過する(回帰なし)

## Part 2 — 実装計画

### Set A: 収穫層
- `scripts/lib/harvest-journal-events.ts`(新規): `harvestJournalEvents(projectDir, outputFile)`。既存`outputFile`の行からeventIdの集合を読み込み、`journalAdapter(projectDir).load()`との差分のみ追記する。CLIエントリ(`--project-dir`, `--output`)も持つ
- `scripts/lib/harvest-journal-events.test.ts`(新規): 重複排除・新規追記・ファイル未存在時の挙動をテスト
- `scripts/harvest-journal-events.sh`(新規): `resolve-log-dir.sh`を使い`logs/journal-harvest.jsonl`を解決して上記CLIを呼ぶ。fail-open(エラーでも exit 0)

### Set B: 集計切替
- `scripts/lib/gate-effectiveness-summary.ts`: `summarizePassFailGates(events: CanonicalEvent[])`を追加。journal由来イベントをagentType別にpass/fail/blocked集計する。`loadHarvestedEvents(logFile)`(JSONL読み込み)も追加
- `scripts/lib/gate-effectiveness-summary.test.ts`: 新関数のテストを追加
- `scripts/summarize-gate-passfail.sh`(新規): harvest済みJSONLを読んでCLI出力する(`summarize-gate-blocked.sh`を置き換え)
- `scripts/summarize-gate-blocked.sh`: 削除(新スクリプトに統合)
- `scripts/gate-effectiveness-monthly-check.sh`: 冒頭でharvestを実行するよう変更。MSG組み立てを新集計ベースに変更し、loop-observability.jsonlベースの部分に自己申告の注記を追加
- `scripts/gate-effectiveness-monthly-check.test.sh`: 既存テストの更新
