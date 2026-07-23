// aidd-phase2.js のReviewフェーズ（issue #45/#292）の判定ロジック。
// 従来はReviewのstatus(fail)を一切見ずdetailのみ使っていたため、指摘があっても
// 後続に何も反映されず「検証完了」として終わっていた。1ラウンド分の結果を見て、
// 「Implementerへ差し戻して再試行すべきか」「これ以上は打ち切ってblockedにすべきか」
// を判定する。エージェント呼び出しを含まない純粋関数のため、LLM呼び出し無しで
// 決定的にテストできる（最大リトライ到達→blockedになる完了条件を含む）。
// aidd-phase2.js（Workflow DSL、require不可）にも同一ロジックをインラインで複製している。
// このファイルはvitestでの単体テスト用の正本。
//
// 重大度分類（severity.js）: findings全件がminorのfailは差し戻し対象にしない
// （UIの軽微な指摘だけで修正ループを回さない。DB/ロジックのcritical/important指摘は従来通り差し戻す）。

import { isMinorOnlyFailure } from './severity.js'

// reviewResults: dimensionsと同じ並びのAgentResult(status/detail/findings)配列
// dimensions: [{ key, label }, ...]
// attempt: 今回が何回目のReviewラウンドか（1始まり）
// maxRetries: Implementerへの差し戻し許容回数（打ち切りはattempt > maxRetries + 1ラウンド目で発生）
//
// 戻り値:
// - done: true ならReviewループを終了する（pass確定 or 打ち切り）
// - blocked: true なら打ち切り（人間に引き渡す）。doneがfalseの場合は常にfalse
// - failingDimensions: 差し戻し対象の観点（{ dim, result }[]）。status==='fail'かつ
//   findings全件minorではないもの（findings省略時はcritical相当として差し戻し対象）
// - blockedDimensions: status==='blocked'、またはstatus==='pass'/'fail'のいずれでもない結果
//   （null＝agent()実行失敗、または未知のstatus値）の観点（{ dim, result }[]）。
//   レビュー対象自体が見つからない等、Implementerへの差し戻しでは解決しない状態のため
//   常に即座に打ち切る
//   （issue #314: 従来はblockedのみの回をdone=true,blocked=falseとして素通りしており、
//   最終returnにblockedAtが付かず「なぜ止まったか」が追跡できなかった）
//   （issue #525のPRレビューで発覚: status==='blocked'のみを明示チェックしていたため、
//   null（agent()実行失敗）がblockedにもfailedにも分類されず、failingDimensions.length===0
//   の分岐に落ちて「全観点pass（指摘なし）」と誤判定される抜け道が残っていた。
//   deny-by-default（quality-gate.jsのshouldBlockと同一発想）に統一する）
export function classifyReviewRound(reviewResults, dimensions, attempt, maxRetries) {
  const blockedDimensions = dimensions
    .map((dim, i) => ({ dim, result: reviewResults[i] }))
    .filter(({ result }) => result?.status !== 'pass' && result?.status !== 'fail')

  if (blockedDimensions.length > 0) {
    return { done: true, blocked: true, failingDimensions: [], blockedDimensions }
  }

  const failingDimensions = dimensions
    .map((dim, i) => ({ dim, result: reviewResults[i] }))
    .filter(({ result }) => result?.status === 'fail' && !isMinorOnlyFailure(result))

  if (failingDimensions.length === 0) {
    return { done: true, blocked: false, failingDimensions: [], blockedDimensions: [] }
  }
  if (attempt > maxRetries) {
    return { done: true, blocked: true, failingDimensions, blockedDimensions: [] }
  }
  return { done: false, blocked: false, failingDimensions, blockedDimensions: [] }
}

// issue #525のPRレビューで発覚: reviewResults[i]がnull（agent()実行失敗）の場合も
// `?? '指摘なし'`で「指摘なし」に丸められ、偽の「レビュー完了・問題なし」に見えていた
// （aidd-phase1.jsのdescribeSweepResultと同型の修正）。
// aidd-phase2.js（Workflow DSL、require不可）にも同一ロジックをインラインで複製している。
export function describeReviewResult(result) {
  if (result === null) return '(実行失敗: エージェントが結果を返しませんでした。手動で再実行してください)'
  return result.detail ?? '指摘なし'
}
