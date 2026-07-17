// Loop Until Dry（aidd-1-1-deep-task.jsのSweepループ）へのbudgetガード（issue #442）。
// budget（ユーザーの「+500k」等の指示からWorkflowツールが算出するトークン予算。
// budget.totalがnullなら予算指定なし）がtotal未設定の場合は、常にtrueを返し
// 既存動作を完全維持する（後方互換）。
// 1ラウンドはSweep 4エージェント + Completeness Critic 1エージェント。閾値は
// issue #442調査時点の実測（軽量Sweep 5エージェントで約28万トークン）に安全マージンを
// 載せた仮置き値であり、正確な見積もりの裏付けはない。運用しながら再調整する前提。
// aidd-1-1-deep-task.js（Workflow DSL、require不可）にも同一ロジックをインラインで複製している。
// このファイルはvitestでの単体テスト用の正本。

// budget.totalが設定されており、かつ次の1ラウンドを賄うだけの残高が無い場合にtrue。
export function isBudgetExhausted({ budget, minRemainingForRound }) {
  return Boolean(budget?.total && budget.remaining() < minRemainingForRound)
}

// Sweepループ(while)の継続条件。dryRounds/maxRoundsの既存条件に加え、budgetガードをORではなくAND連結する
// （budgetが尽きていなくてもdry収束・ラウンド上限到達なら従来通り停止する）。
export function shouldContinueLoop({ dryRounds, round, maxRounds, budget, minRemainingForRound }) {
  if (dryRounds >= 2) return false
  if (round > maxRounds) return false
  if (isBudgetExhausted({ budget, minRemainingForRound })) return false
  return true
}
