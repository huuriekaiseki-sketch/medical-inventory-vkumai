import { describe, it, expect } from 'vitest'
import { isLoggableAgentType } from '../loop-observability-expectation.js'

describe('isLoggableAgentType', () => {
  it('reviewerはtrue（.claude/agents/reviewer.mdにログ記録指示がある）', () => {
    expect(isLoggableAgentType('reviewer')).toBe(true)
  })

  it('implementerはtrue（.claude/agents/implementer.mdにログ記録指示がある）', () => {
    expect(isLoggableAgentType('implementer')).toBe(true)
  })

  it('judge-panelはtrue（.claude/agents/judge-panel.mdにログ記録指示がある）', () => {
    expect(isLoggableAgentType('judge-panel')).toBe(true)
  })

  it('sweep-uiはfalse（ログ記録指示を持たないagentType）', () => {
    expect(isLoggableAgentType('sweep-ui')).toBe(false)
  })

  it('contract-writerはfalse（ログ記録指示を持たないagentType）', () => {
    expect(isLoggableAgentType('contract-writer')).toBe(false)
  })

  it('integratorはfalse（ログ記録指示を持たないagentType）', () => {
    expect(isLoggableAgentType('integrator')).toBe(false)
  })

  it('未知のagentTypeはfalse', () => {
    expect(isLoggableAgentType('unknown-agent')).toBe(false)
  })
})
