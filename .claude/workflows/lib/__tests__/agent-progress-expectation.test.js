import { describe, it, expect } from 'vitest'
import { isProgressLoggableAgentType } from '../agent-progress-expectation.js'

describe('isProgressLoggableAgentType', () => {
  it('common.mdに列挙された進捗記録対象agentTypeはtrue', () => {
    expect(isProgressLoggableAgentType('sweep-ui')).toBe(true)
    expect(isProgressLoggableAgentType('sweep-data')).toBe(true)
    expect(isProgressLoggableAgentType('sweep-db')).toBe(true)
    expect(isProgressLoggableAgentType('sweep-types')).toBe(true)
    expect(isProgressLoggableAgentType('implementer')).toBe(true)
    expect(isProgressLoggableAgentType('reviewer')).toBe(true)
    expect(isProgressLoggableAgentType('integrator')).toBe(true)
    expect(isProgressLoggableAgentType('judge-panel')).toBe(true)
    expect(isProgressLoggableAgentType('proposer')).toBe(true)
    expect(isProgressLoggableAgentType('adversarial-verify')).toBe(true)
    expect(isProgressLoggableAgentType('completeness-critic')).toBe(true)
    expect(isProgressLoggableAgentType('contract-writer')).toBe(true)
  })

  it('一覧に無いagentType・未指定はfalse', () => {
    expect(isProgressLoggableAgentType('claude')).toBe(false)
    expect(isProgressLoggableAgentType(undefined)).toBe(false)
    expect(isProgressLoggableAgentType('')).toBe(false)
  })
})
