# 2026-08-26 journal-based-gate-summary

## フロー実行時間
- Phase 1（調査）:    約3分（軽量Sweep 4軸×1ラウンド）
- Phase 2〜5（実装）: 直接実装（TDD）約40分
- セッション総時間:   人間レビュー待ち含め同日内

## フロー実行統計

### Phase 1 調査
- Sweeper: 4台 × 1ラウンド
- 指摘あり軸数: 2 / 4（ただしいずれもissue #642スコープ外の汎用指摘。うちget_admin_status RPCの引数検証漏れは別タスクとして切り出し済み）

### Phase 2〜5 実装・検証
- implementer: 0台（レビュー観点が明確な観測ツール層のみの変更のため、Fable本体が直接TDD実装）
- 合計エージェント: 4台（Phase 1のみ）

## 作業サマリ（issue #642）
- 収穫層: `scripts/lib/harvest-journal-events.ts` + `scripts/harvest-journal-events.sh` を新設。wf_*のjournalイベントを`logs/journal-harvest.jsonl`へ`source+agentId`キーで重複排除しつつ追記。リポジトリ対応の全projectディレクトリ（worktreeセッション分含む）を走査する
- 集計切替: `summarizePassFailGates()`を追加し、月次サマリのagent別集計を収穫済みjournalベースへ移行。`summarize-gate-blocked.sh`は`summarize-gate-passfail.sh`へ統合し廃止
- `gate-effectiveness-monthly-check.sh`: 30日通知ゲートの前に毎回harvestを実行。loop-observability側集計に「自己申告・欠落あり得る」注記を追加

## 検証済み
- `npx vitest run` 1439件全PASS（新規12件含む）/ `npx tsc --noEmit` 0エラー / `npx eslint --max-warnings=0` 0件
- `bash scripts/gate-effectiveness-monthly-check.test.sh` ALL PASSED（scenario 6を実体検証型に強化）
- 実データE2E: harvest実行で206イベント収穫（メイン106+worktree100）、agentType別pass/fail/blocked集計の実出力を確認

## 結果
- うまくいったこと: テスト強化(scenario 6)が既存の潜在バグ2件（tsxのCLIエントリ判定がsymlinkパスで無言スキップ／テストサンドボックスへのmodel-pricing.tsコピー漏れ）を検出した
- 問題・気になった点: 旧scenario 6は見出し文字列しか検証しておらず、TS集計が実際には落ちていても緑になっていた（green方向のみ検証パターン、known-failure-patterns.md該当）
- 次の課題: feature別・token/cost集計のjournal化（INTENT規約からのfeature復元）は未着手のままissue #642のスコープ外として残る
