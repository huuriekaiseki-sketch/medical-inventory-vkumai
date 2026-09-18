// aidd-phase2.js の最終的な「完了(DONE)」判定ロジック（issue #46）。
// 各フェーズのゲート（Manifest Check・Contract+DB・Implement・Integrate・Review）は
// 個別にdeny-by-defaultで中断するが、それらを組み合わせた「全条件を満たしたときだけ
// DONEを返す」という完了条件自体は明示的に定義・テストされていなかった。
// DONE = 全実装ブランチがpass（またはfindings全件minorのfail） AND 統合ゲート(test/lint/tsc)がpass
//        AND 全観点のReviewがpass(critical/important相当のfailが0) AND Run ManifestのspecHashが一致
//        AND その統合ゲートの結果が「最後にコードが変わったあと」に取られたものであること
// エージェント呼び出しを含まない純粋関数のため、LLM呼び出し無しで決定的にテストできる。
// aidd-phase2.js（Workflow DSL、require不可）にも同一ロジックをインラインで複製している。
// このファイルはvitestでの単体テスト用の正本。

import { isMinorOnlyFailure } from './severity.js'

function allPass(results) {
  return results.length > 0 && results.every(r => r?.status === 'pass' || isMinorOnlyFailure(r))
}

// 差し戻し修正そのものの成否。
// null = 「差し戻しは一度も起きなかった」の明示。undefined = 申告が無い（呼び出し側が
// 古いシグネチャのまま）ので、deny-by-default で不合格にする。
function lastRetryAccepted(result) {
  if (result === null) return true
  if (result === undefined) return false
  return result.status === 'pass' || isMinorOnlyFailure(result)
}

// implResults: [contractResult, dbResult, dataResult, apiResult, uiResult]
// integrationResult: integratorのAgentResult（test/lint/tsc全て緑であることを含む）
// reviewResults: 4観点reviewerのAgentResult配列
// manifestCheck: Run ManifestのspecHash突合結果のAgentResult
// evidence: { integrationFresh, lastRetryResult } — 証拠の鮮度（下記）
//
// なぜ evidence が要るか（レビュー指摘 R01）:
// Reviewの差し戻しループでImplementerがコードを直したあと、integrationResult は
// 「直す前」の木に対して取った結果のままだった。修正で型エラーが入っても、レビューが
// 通りさえすればDONE=trueになる。「テストが通った」という事実には、それが**どの木に対して**
// 取られたかが必ず付いていないと合否に使えない。integrationFresh は「最後にコードが
// 変わったあとで統合ゲートを取り直したか」を表し、取り直していなければ（=古い証拠なら）
// 他が全て緑でもDONEにしない。未申告(undefined)も古い扱いにする（deny-by-default）。
export function computeDone(implResults, integrationResult, reviewResults, manifestCheck, evidence) {
  return (
    allPass(implResults) &&
    integrationResult?.status === 'pass' &&
    allPass(reviewResults) &&
    manifestCheck?.status === 'pass' &&
    evidence?.integrationFresh === true &&
    lastRetryAccepted(evidence?.lastRetryResult)
  )
}
