// scripts/log-loop-observability.sh の呼び出し指示を持つagentType（issue: loop-observabilityログの記録漏れ検知）。
// .claude/agents/{reviewer,implementer,judge-panel}.md にのみ「## レビュー結果のログ記録」等の指示があり、
// sweep-*/contract-writer/integrator等の他agentTypeにはそもそも指示自体が存在しない。
const LOGGABLE_AGENT_TYPES = new Set(['reviewer', 'implementer', 'judge-panel'])

export function isLoggableAgentType(agentType) {
  return LOGGABLE_AGENT_TYPES.has(agentType)
}
