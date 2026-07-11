// AgentResult（docs/agents/agent-result-schema.md）のstatus='fail'|'blocked'を検知する品質ゲート判定。
// blockedはfailより情報量が少ない「そもそも着手不能」な状態のため、failと同様に後続フェーズへ
// 進めてはならない（進めると存在しない前提を元にした無駄な実装・レビューが走る）。
// aidd-phase2.js（Workflow DSL、require不可）にも同一ロジックをインラインで複製している。
// このファイルはvitestでの単体テスト用の正本。

export function shouldBlock(results) {
  return results.some(r => r?.status === 'fail' || r?.status === 'blocked')
}
