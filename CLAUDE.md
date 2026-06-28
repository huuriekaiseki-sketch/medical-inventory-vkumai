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

## ワークフローの使い方
ワークフローを呼ぶ前に必ず `.claude/workflows/` の該当JSファイルを Read すること。
詳細な手順・args・完了後の次ステップはすべてそのファイルに書いてある。

- Phase 1〜2 → `.claude/workflows/aidd-phase1.js` を読む
- Phase 3〜5 → `.claude/workflows/aidd-phase2.js` を読む
- 深掘り調査・仕様検証が必要なとき（条件付き）→ `.claude/workflows/aidd-1-1-deep-task.js` を読む
- セッション終了時 → Stop hook が自動でレポートを生成（`~/aidd_session_report.sh`）

## AIDD stats 書き出しルール
以下の5タイミングで必ず Bash 実行する（Stop hook が自動でレポート生成）：

```bash
# 1. AIDDフロー開始時（aidd-phase1.js を呼ぶ前）
echo '' | ~/write_aidd_stats.sh start "<feature>" "$(pwd)"

# 2. phase1 開始直前
echo '' | ~/write_aidd_stats.sh phase1_start "<feature>" "$(pwd)"

# 3. phase1 完了直後（戻り値の stats を渡す）
echo '{"agents":4,"rounds":1,"findingCount":2}' | ~/write_aidd_stats.sh phase1 "<feature>" "$(pwd)"

# 4. phase2 開始直前
echo '' | ~/write_aidd_stats.sh phase2_start "" ""

# 5. phase2 完了直後（戻り値の stats を渡す）
echo '{"implAgents":2,"reviewAgents":4,"totalAgents":7,"implSuccessCount":2}' | ~/write_aidd_stats.sh phase2 "" ""
```
※ start を呼び忘れた場合は phase1_start_at がフォールバックで使われる

## 絶対ルール
- 確認を求めるのは「仕様レビュー（停止①）」と「構造化レビュー（停止②）」の2箇所のみ。
- それ以外は止まらず自律的に進める。
- 停止①：仕様書を提示したら、人間が承認するまで Phase 3（実装）へ進まないこと。
- 停止②：構造化レビューは `/structured-review` で人間が起動するまで勝手に実行しないこと。

## サーキットブレーカー
- フロー開始時に `/goal` を1回セットしてから自走に入る（条件の書き方は下記）。
- 完了条件はタイトに（曖昧な条件は無限ループの燃料）
- `/goal` の条件に**ターンまたは時間の上限を条件文として**含める（例：「or stop after 20 turns」）
- Autoモードで全ツールを無条件承認しない
- テスト修正は1セット3回まで（局所上限）
- フロー全体の上限も必ず持つ（局所上限だけでは財布を守れない）
