// Implement/Integrate/Reviewの各ゲートに共通する重大度判定ロジック。
// Sweep/Draft/Adversarial Verify（aidd-1-1-deep-task.js）が既に採用しているseverity
// (critical/important/minor)を実装後ゲートにも展開する（issue: AIDD品質ゲートへの重大度分類導入）。
//
// deny-by-default原則は維持する: statusがfailでもfindingsが無ければ「重大度不明」として
// 従来通りブロックする。findingsが明記され、かつ全件がminorの場合のみ通過させる。
// severityが省略・不正な値の指摘が1件でもあればcritical相当としてブロックする
// （fail-open防止。issue #289/#291と同じ考え方）。

export function isMinorOnlyFailure(result) {
  if (result?.status !== 'fail') return false
  if (!Array.isArray(result.findings) || result.findings.length === 0) return false
  return result.findings.every(f => f?.severity === 'minor')
}
