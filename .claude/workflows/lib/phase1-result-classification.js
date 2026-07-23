// docs/agents/agent-result-schema.md 参照。
// Sweep結果（status: 'pass'|'blocked'、またはagent()自体が失敗した場合のnull）を分類する。
// nullは、権限不足・対象コード不在等でagent自身がstatus:'blocked'と自己申告した場合とは異なり、
// エージェント呼び出し自体が致命的エラー・スキップで結果を返せなかったケースを指す
// （Workflowツールの仕様。agent()はretry後の致命的APIエラー・ユーザースキップ時にnullを返す）。
// 従来はnullも`?? '指摘なし'`で丸められ、Sweepが全滅してもfindingCount:0の偽の正常完了に
// 見えていた（issue #521）。
// aidd-phase1.js（Workflow DSL、require不可）にも同一ロジックをインラインで複製している。
// このファイルはvitestでの単体テスト用の正本。

export function describeSweepResult(result) {
  if (result === null) return '(実行失敗: エージェントが結果を返しませんでした。手動で再実行してください)'
  return result.detail ?? '指摘なし'
}

export function classifyPhase1Results(results) {
  return {
    findingCount: results.filter(r => r?.status === 'pass' && r?.detail !== '指摘なし').length,
    blockedCount: results.filter(r => r?.status === 'blocked').length,
    failedCount:  results.filter(r => r === null).length,
  }
}
