// docs/agents/common.md「サブエージェント進捗の可視化（issue #18）」に列挙されたagentTypeの一覧。
// これらは scripts/log-agent-progress.sh の呼び出し指示をシステムプロンプトに持つ想定
// （.claude/agents/*.md参照）。issue #339: この一覧を「期待される進捗記録件数」として
// ワークフロー側から返し、scripts/check-agent-progress-gap.sh で実際のログと突き合わせる。
const PROGRESS_LOGGABLE_AGENT_TYPES = new Set([
  'sweep-db',
  'sweep-ui',
  'sweep-types',
  'sweep-data',
  'implementer',
  'reviewer',
  'integrator',
  'judge-panel',
  'proposer',
  'adversarial-verify',
  'completeness-critic',
  'contract-writer',
])

export function isProgressLoggableAgentType(agentType) {
  return PROGRESS_LOGGABLE_AGENT_TYPES.has(agentType)
}
