# 2026-07-13 issue18-agent-progress-heartbeat

## 対応issue
- issue #18「サブエージェントオブザーバビリティ：進捗・状態・タスク残量の可視化」

## 作業サマリ
- 変更した目的: AIDDサブエージェント（sweep-db/sweep-ui/sweep-types/sweep-data/implementer/reviewer/
  integrator/judge-panel/adversarial-verify/completeness-critic/contract-writer）が動作中、メイン
  セッションから進捗・生死が見えない問題（issue #18）を解消する
- 変更した範囲:
  - `scripts/log-agent-progress.sh`（新規）: エージェントが進捗を`logs/agent-progress.jsonl`に自己申告するCLI
  - `scripts/show-agent-status.sh`（新規）: 直近の状態を一覧表示し、既定180秒（3分）以上runningから
    更新がないエージェントを「止まってる？」として表示する
  - `scripts/show-agent-status.test.sh`（新規）: 上記2スクリプトの回帰テスト（`schema-drift-reconcile.test.sh`と同じ作法）
  - `docs/agents/common.md`: 「サブエージェント進捗の可視化」節を追加し、全AIエージェント共通ルールとして明文化
  - `.claude/agents/*.md`（11ファイル全て）: 各エージェントの開始時・終了時に
    `scripts/log-agent-progress.sh`を呼ぶ具体的な指示を追加
- 触っていない範囲: `proposer`エージェント（本リポジトリに`.claude/agents/proposer.md`が存在せず、
  リポジトリ外で定義されているため対象外）。実際のAIDDフロー実行中に新しい仕組みが機能するかの
  実地検証（次回セッションで確認要）

## 設計上の判断（ユーザーとの事前合意）
issue #18は「メインセッションから任意のサブエージェントの実行中状態を能動的に監視する」ことを
求めているが、Claude Codeのハーネス自体には完了時の自動通知（`/workflows`のライブ進捗除く）しか
無く、実行中の任意時点での状態取得手段がモデル側に提供されていない。そのため実装可能なのは
「エージェントが自己申告した進捗をログに書き、それを一覧表示するビューア」というベストエフォート
方式のみであり、これは`scripts/log-loop-observability.sh`と同じ構造的限界（自然言語指示への依存・
強制力なし）を持つことを事前にユーザーに説明し、了承を得た上で本プロジェクトのAIDDサブエージェント
限定の実装に絞った。

## 検証済み
- 実行したコマンド: `bash scripts/show-agent-status.test.sh`（9assert全OK）、`npx vitest run`（630件全緑）、
  `npm run lint`（エラーなし）、`npx tsc --noEmit`（エラーなし）。`npm run ai:check`は`.env.test`未設定に
  よりこの環境では実行不可（既存の環境制約）
- 確認した画面: なし（バックエンド・スクリプトのみ）
- 確認したDB/RLS: 対象外（DB変更なし）
- 他テナントのIDでアクセスし、弾かれることを確認したか: 対象外（RLS/facility境界に触れていない）

## 既知の未対応
- 今回あえて対応しなかったこと: 実際のAIDDフロー（Phase 1〜5）実行時に、11個のサブエージェントが
  実際に`log-agent-progress.sh`を呼び出すかどうかの実地検証。今回は指示文の追加とスクリプト自体の
  単体テストのみ
- 理由: 実地検証には実際のAIDDフロー1本の完走が必要で、本セッションのスコープ（issue #18そのものの
  実装）を超える。loop-observabilityの記録漏れ検知（`check-loop-observability-gap.sh`）と同様、
  記録漏れそのものを検知する仕組みは今後の課題として残っている
- 次に触るなら見る場所: 次回AIDDフロー実行時に`logs/agent-progress.jsonl`が実際に増えているか確認する。
  増えていなければ、エージェント定義への指示の伝わり方（システムプロンプトの読み込まれ方）を疑う

## 後任AIへの注意
- この実装で壊してはいけない前提: `logs/agent-progress.jsonl`は`/logs/`として`.gitignore`済み。
  コミットに含めない
- 似ているが別物の用語: `scripts/log-loop-observability.sh`（実装セットの試行ごとのpass/fail記録、
  事後ログ）と`scripts/log-agent-progress.sh`（エージェントの生死・進捗のハートビート、リアルタイム
  ログ）は目的も記録先ファイルも別物。混同しないこと
- 勝手にリファクタしない場所: 既存の`scripts/log-loop-observability.sh`・
  `scripts/check-loop-observability-gap.sh`は本issueの対象外であり変更していない

## フロー実行時間
- Phase 1（調査）: 既存harness機能の限界調査・issue内容確認、約5分
- Phase 2〜5（実装）: スクリプト2本＋テスト＋ドキュメント11ファイル更新、約20分
- AI稼働合計: 約25分
- セッション総時間: ユーザーとの方針確認（1回）含め約30分

## フロー実行統計
### Phase 1 調査
- Sweeper: 0台（本セッションでは直接調査、Explore/Sweepエージェントは使用せず）
- 指摘あり軸数: 1 / 1（ハーネスの構造的制約という前提整理）

### Phase 2〜5 実装・検証
- implementer: 本セッション内で直接実装（1名・直列）
- integrator: 該当なし
- reviewer: 該当なし（vitest / lint / tsc / 独自bashテストで検証）
- 合計エージェント: 0台（Phase1同様、直接実装）
- 実装成功: 1 / 1

## Loop Observability要約
このセッション中の新規記録なし（AIDDフロー本体を経由しない直接実装のため対象外）

## 結果
- うまくいったこと: 既存の`log-loop-observability.sh`/`schema-drift-reconcile.test.sh`の作法を踏襲し、
  一貫性のある形で新しいスクリプトとテストを追加できた
- 問題・気になった点: この仕組みの実効性は「エージェントが実際に呼ぶかどうか」に完全に依存しており、
  記録漏れ検知の仕組み（loop-observabilityにあるもの）がまだ無い
- 次の課題: 記録漏れ検知（`check-loop-observability-gap.sh`相当）の追加を検討する。実際のAIDDフロー
  実行での実地検証
