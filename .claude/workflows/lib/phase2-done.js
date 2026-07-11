// aidd-phase2.js の最終的な「完了(DONE)」判定ロジック（issue #46）。
// 各フェーズのゲート（Manifest Check・Contract+DB・Implement・Integrate・Review）は
// 個別にdeny-by-defaultで中断するが、それらを組み合わせた「全条件を満たしたときだけ
// DONEを返す」という完了条件自体は明示的に定義・テストされていなかった。
// DONE = 全実装ブランチがpass（またはfindings全件minorのfail） AND 統合ゲート(test/lint/tsc)がpass
//        AND 全観点のReviewがpass(critical/important相当のfailが0) AND Run ManifestのspecHashが一致
// エージェント呼び出しを含まない純粋関数のため、LLM呼び出し無しで決定的にテストできる。
// aidd-phase2.js（Workflow DSL、require不可）にも同一ロジックをインラインで複製している。
// このファイルはvitestでの単体テスト用の正本。

import { isMinorOnlyFailure } from './severity.js'

function allPass(results) {
  return results.length > 0 && results.every(r => r?.status === 'pass' || isMinorOnlyFailure(r))
}

// implResults: [contractResult, dbResult, dataResult, apiResult, uiResult]
// integrationResult: integratorのAgentResult（test/lint/tsc全て緑であることを含む）
// reviewResults: 4観点reviewerのAgentResult配列
// manifestCheck: Run ManifestのspecHash突合結果のAgentResult
export function computeDone(implResults, integrationResult, reviewResults, manifestCheck) {
  return (
    allPass(implResults) &&
    integrationResult?.status === 'pass' &&
    allPass(reviewResults) &&
    manifestCheck?.status === 'pass'
  )
}
