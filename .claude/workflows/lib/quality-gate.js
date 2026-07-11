// AgentResult（docs/agents/agent-result-schema.md）の品質ゲート判定。
// deny-by-default: 全員がstatus==='pass'でない限り止める（fail/blockedはもちろん、
// null・未返却（エージェントが致命的エラーで死んだ場合）・未知のstatus値も含めて
// 「passと確認できないものは全て止める」。fail-open（failを探す方式）だと、
// 想定外の値がすべて素通りしてしまう（issue #289）。
// aidd-phase2.js（Workflow DSL、require不可）にも同一ロジックをインラインで複製している。
// このファイルはvitestでの単体テスト用の正本。

export function shouldBlock(results) {
  if (results.length === 0) return false
  return !results.every(r => r?.status === 'pass')
}
