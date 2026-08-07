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

// 単発タスクの総量サーキットブレーカー（2026-08-06 mentor評価）。issue #500の再発防止
// （キーワード誤判定という原因別の対策）とは独立に、「別の原因で暴走しても量で止める」
// 保険として機能する。budget.total（ユーザーの「+500k」等の明示予算）が設定されている場合は
// Workflowツール本体がハード強制する（超過時にagent()がthrowする）ため、このガードは
// total未設定時のみdefaultCapを代替上限として適用する。budget.spent()はメインループと
// 全workflowを合算したターン累計出力トークンであり、このworkflow単体の消費量ではない点に注意。
// aidd-1-1-deep-task.js / aidd-phase2.js（Workflow DSL、require不可）にインライン複製している。
// 同期は budget-guard-sync.test.js が検証する。このファイルは単体テスト用の正本。
// 引数を既存関数のようなオブジェクト分割代入にしていないのは意図的:
// extract-declaration.js は宣言後の最初の `{` を関数本体とみなすため、パラメータに
// 分割代入 `({ ... })` があると引数部分だけを抽出してしまい、本体のドリフトを検知できない
// （budget-guard-sync.test.js 導入時のfault injectionで実測した偽陰性）。
export function isDefaultCapExceeded(budget, defaultCap) {
  if (!budget || typeof budget.spent !== 'function') return false
  if (budget.total) return false
  return budget.spent() >= defaultCap
}

// Sweepループ(while)の継続条件。dryRounds/maxRoundsの既存条件に加え、budgetガードをORではなくAND連結する
// （budgetが尽きていなくてもdry収束・ラウンド上限到達なら従来通り停止する）。
export function shouldContinueLoop({ dryRounds, round, maxRounds, budget, minRemainingForRound }) {
  if (dryRounds >= 2) return false
  if (round > maxRounds) return false
  if (isBudgetExhausted({ budget, minRemainingForRound })) return false
  return true
}
