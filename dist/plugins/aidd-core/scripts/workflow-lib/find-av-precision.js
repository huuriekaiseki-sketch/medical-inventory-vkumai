// Find→Adversarial Verify裁定結果からprecision（偽陽性率の裏返し＝生存率）を集計する
// 純粋関数（issue #432）。
//
// 注意（重要な訂正）: issue #432起票時点の想定は「Sweep指摘のprecisionをAV裁定結果から
// 集計する」だったが、実際にAdversarial Verifyが裁定するのはFindフェーズ（仕様書ドラフトへの
// logic/data/security/ux/performance5軸の再発見）の指摘であり、Sweepフェーズ（ui/data/db/types
// 軸のコードベース調査）の指摘ではない（両者は別の生成プロセスで、構造的に1:1対応しない）。
// このためここでは「Find指摘のAV生存率」として実装している。
//
// Workflow DSL（aidd-1-1-deep-task.js）自体はrequire不可のため、この関数の判定ロジックは
// aidd-1-1-deep-task.js内にインライン複製されている（severity.js等と同じパターン）。
export function computeFindAvPrecision(dedupedFindings, toVerify, verdicts, autoSurvivedMinor) {
  const survivedFromVerify = toVerify.filter((_, i) => !verdicts[i]?.refuted)
  const survived = [...survivedFromVerify, ...autoSurvivedMinor]

  const byLens = {}
  toVerify.forEach((f, i) => {
    const lens = f?.lens ?? 'unknown'
    byLens[lens] ??= { verified: 0, survived: 0 }
    byLens[lens].verified++
    if (!verdicts[i]?.refuted) byLens[lens].survived++
  })

  return {
    findCount: dedupedFindings.length,
    verifiedCount: toVerify.length,
    survivedCount: survived.length,
    autoSurvivedMinorCount: autoSurvivedMinor.length,
    survivalRate: toVerify.length > 0 ? survivedFromVerify.length / toVerify.length : null,
    byLens,
  }
}
