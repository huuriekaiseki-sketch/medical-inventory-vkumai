# 2026-07-13 loop-observability-transcript-reconstruc

AIDDのマルチエージェントフロー（Workflow/aidd-phase1/aidd-phase2）は使わず、issue #312に対して
Claude本体が単独で調査・設計・実装した（手動実装）。

## フロー実行時間
- Phase 1（調査）:    —（AIDDフロー不使用）
- Phase 2〜5（実装）: —（AIDDフロー不使用）
- AI稼働合計:         —
- セッション総時間:   —（人間レビュー待ち含む）

## フロー実行統計

### 調査
journal.jsonl・agent-*.jsonl・.meta.jsonの実データをサンプリングして、
timestamp/model/tokens/costUsd/result(status/detail)の復元精度を手動検証した
（ユーザー指示で1件の親ログ突き合わせを先に実施）。

### 実装（単独・TDD）
- 実装エージェント: 1（Claude本体、並列化なし）
- 成果物: `scripts/lib/model-pricing.ts`, `scripts/lib/reconstruct-loop-observability.ts`
  とそれぞれのテスト
- テスト結果: 新規20件 pass、既存含む全572件（94ファイル）pass、lint 0 error

## 結果
- うまくいったこと:
  - journal.jsonl単体では timestamp/model/feature等が欠落していたが、
    `subagents/workflows/wf_*/agent-<id>.jsonl` + `.meta.json` という別のデータソースに
    ms単位のtimestamp・正確なmodel名・usageが残っていることを実データで確認できた
  - 実際のissue #165実装時のワークフロー実行ディレクトリに対してスクリプトを走らせ、
    pass/blockedの判定が正しく復元されることを確認した
- 問題・気になった点:
  - `feature`名はtranscriptから自動導出できず、CLI引数で手動指定する必要がある
    （docs/sessions/配下のファイル名パターンからの自動導出は今回は見送り、将来の改善候補）
  - `intent`はプロンプト冒頭1文の抜粋、`scenario`は固定の「復元不能」文言であり、
    自己申告時点の情報粒度には及ばない
  - `attempt`番号は同一ディレクトリ内の同一agentTypeをstartTimestamp昇順で採番しているだけなので、
    並列実行された同じagentType（例: 並列implementer）がある場合は「再試行」ではなく
    「並列実行の順序」を採番してしまう点に注意が必要
- 次の課題:
  - feature名の自動導出（docs/sessions/ファイル名との相関）
  - 過去の全wf_*ディレクトリを一括スキャンするバッチ実行の追加
  - 実際に本番のlogs/loop-observability.jsonlへ追記する運用（今回はライブラリ実装のみ）
