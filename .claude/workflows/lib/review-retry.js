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
export function classifyReviewRound(reviewResults, dimensions, attempt, maxRetries) {
  const failingDimensions = dimensions
    .map((dim, i) => ({ dim, result: reviewResults[i] }))
    .filter(({ result }) => result?.status === 'fail' && !isMinorOnlyFailure(result))

  if (failingDimensions.length === 0) {
    return { done: true, blocked: false, failingDimensions: [] }
  }
  if (attempt > maxRetries) {
    return { done: true, blocked: true, failingDimensions }
  }
  return { done: false, blocked: false, failingDimensions }
}
