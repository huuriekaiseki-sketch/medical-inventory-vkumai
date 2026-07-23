@docs/agents/common.md

# Parallel Subagent Framework

→ 全体マップ: [`docs/ai-config-map.md`](docs/ai-config-map.md)

## プロジェクト設定
- テストコマンド: npm test
- Lintコマンド:   npm run lint
- UIディレクトリ: src/app/ / src/components/ / データ取得: src/lib/supabase/ / DB: Supabase (PostgreSQL)

## フロー（骨格）
Phase 1 調査(並列) → 
Phase 2 仕様書(並列グループ宣言) → 
[停止① 人間レビュー] → 
Phase 3 実装(TDD・並列) → 
Phase 4 統合ゲート → 
Phase 5 検証(並列) → 
[停止② 構造化レビュー]

## AIDD stats 書き出しルール
**SDD・AIDD・手動実装など、フロー種別を問わず**以下のタイミングで必ず Bash 実行する（Stop hook が自動でレポート生成）。
stats JSON は標準入力ではなく**第4引数**で渡す（パイプ・リダイレクト・`$(pwd)`は使わず、project_dirは実際の絶対パスを直接書く。許可リストのワイルドカードマッチを崩さないため）：

```bash
# 1. AIDDフロー開始時（aidd-phase1-router.js を呼ぶ前）
~/write_aidd_stats.sh start "<feature>" "<project_dirの絶対パス>"

# 2. phase1 開始直前
~/write_aidd_stats.sh phase1_start "<feature>" "<project_dirの絶対パス>"

# 3. phase1 完了直後（戻り値の stats を渡す）
~/write_aidd_stats.sh phase1 "<feature>" "<project_dirの絶対パス>" '{"agents":4,"rounds":1,"findingCount":2}'

# 4. phase2 開始直前
~/write_aidd_stats.sh phase2_start "" ""

# 5. phase2 完了直後（戻り値の stats を渡す）
~/write_aidd_stats.sh phase2 "" "" '{"implAgents":2,"reviewAgents":4,"totalAgents":7,"implSuccessCount":2}'
```
※ start を呼び忘れた場合は phase1_start_at がフォールバックで使われる
※ start の呼び忘れは Stop hook（`scripts/check-aidd-stats-recorded.sh`、issue #495）が
  Workflow実行の形跡と突き合わせて機械検知し警告する（セッションにつき1回・warningのみ）
※ phase1/phase2 の呼び忘れは Stop hook（`scripts/check-aidd-phase-stats-recorded.sh`、
  issue #524）が、Workflow実行記録（wf_*.json）内のphase1/phase2形跡と突き合わせて機械検知し
  警告する（セッションにつき1回・warningのみ。近似判定のため過検知を許容する設計）

## gap check state 記録ルール（issue #488）
AIDDフロー実行時は、上記statsと合わせて以下も呼ぶ（gap check本体はStop hookが自動実行する。
手動での check-*-gap.sh 実行は再検証したい場合のみでよい。詳細は `docs/agents/common.md`
「loop-observabilityログの記録漏れ検知」参照）:

```bash
# 1. フロー開始時（Phase 1の前に1回。件数計測はスクリプトが行う）
scripts/record-gap-check-state.sh before

# 2. 各フェーズ完了後（戻り値のexpected件数を加算記録。無い方の引数は省略可）
scripts/record-gap-check-state.sh expected --agent-progress 4
scripts/record-gap-check-state.sh expected --loop-observability 10 --agent-progress 12
```

## 絶対ルール
- 確認を求めるのは「仕様レビュー（停止①）」と「構造化レビュー（停止②）」の2箇所のみ。
- それ以外は止まらず自律的に進める。
- 停止①：仕様書を提示したら、人間が承認するまで Phase 3（実装）へ進まないこと。
- 停止②：構造化レビューは `/structured-review` で人間が起動するまで勝手に実行しないこと。

## 長時間自律実行の指示（AIDDフロー中）
- **ターン終了前の自己チェック**: ターンを終える前に自分の最終段落を確認し、それが計画・約束・「次にXをします」であれば、ターンを終えずその作業をツール呼び出しで今実行する。ターンを終えてよいのは、タスク完了時か、ユーザーにしか出せない入力（停止①②）でブロックされた時のみ。
- **コンテキスト安心指示**: コンテキスト残量を理由に、停止・要約・新セッションの提案・作業のスコープ削減をしない。コンテキストはハーネスが自動で圧縮し作業は継続できる。
- **完了報告の監査指示**: フロー完了を報告する前に、各主張を今セッションのツール結果（Workflowの戻り値・journal.jsonl・gap checkの実行結果）と突き合わせる。証拠を指せる作業のみ完了として報告し、未検証のものは未検証と明記する。gap checkを実行していない場合は完了報告に「gap check未実施」と書く。

## サーキットブレーカー
- フロー開始時に `/goal` を1回セットしてから自走に入る（条件の書き方は下記）。
- 完了条件はタイトに（曖昧な条件は無限ループの燃料）
- `/goal` の条件は**ターン数の上限を自然文の条件文に埋め込む形**で指定する
  （例：「全フェーズ(Phase 1〜5)完了、または20ターン経過で停止」。`/goal`は時間ベースの上限を
  直接サポートしていない（issue #441で実機確認済み）ため、時間で区切りたい場合もターン数に
  換算して埋め込むこと）
- `/goal`はセッションスコープの機能で、毎ターン終了後にLLM（既定Haiku）が会話内容のみで
  達成条件を判定する（ツール呼び出しは行わない）。「/goalが設定されているか」を外部から
  機械的に検知する手段は公式に無いため、フロー開始前に呼び忘れていないかは自己申告に
  依存する（`docs/agents/common.md`「検知手段のないルールの棚卸し」に記載）
- Autoモードで全ツールを無条件承認しない
- **テスト修正3回まで/フロー全体の上限、という2つのローカル上限の役割分担**:
  Workflow内部のretryループ（review-implementer retry最大3回等）は既にコードで強制されている。
  `/goal`が担うのはWorkflow**外**、つまりこのセッション自身が手動でターンを重ねて修正・再試行する
  ループの上限であり、両者は別レイヤーの防御として併存する（issue #441）
- フロー全体の上限も必ず持つ（局所上限だけでは財布を守れない）
