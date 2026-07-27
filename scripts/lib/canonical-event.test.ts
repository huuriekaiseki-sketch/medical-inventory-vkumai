import { describe, expect, it } from 'vitest'
import { buildEventId, extractAgentType, KNOWN_AGENT_TYPES } from './canonical-event'

describe('KNOWN_AGENT_TYPES', () => {
  it('12種類のagentTypeを含む', () => {
    expect(KNOWN_AGENT_TYPES).toHaveLength(12)
    expect(KNOWN_AGENT_TYPES).toContain('sweep-ui')
    expect(KNOWN_AGENT_TYPES).toContain('implementer')
  })
})

describe('extractAgentType', () => {
  it('agentType単体の完全一致を認識する', () => {
    expect(extractAgentType('reviewer')).toBe('reviewer')
  })

  it('役割サフィックス付き(reviewer-correctness)からagentTypeを復元する', () => {
    expect(extractAgentType('reviewer-correctness')).toBe('reviewer')
  })

  it('既知agentTypeに前方一致しない場合はnullを返す', () => {
    expect(extractAgentType('unknown-agent')).toBeNull()
  })

  it('sweep-uiとsweep-dataのように前方一致が紛らわしい場合でも正しく判定する', () => {
    expect(extractAgentType('sweep-data-something')).toBe('sweep-data')
  })
})

describe('buildEventId', () => {
  it('source:agentType:timestamp:lineIndexの形式で組み立てる', () => {
    expect(buildEventId('agent-progress', 'implementer', '2026-07-27T00:00:00Z', 0)).toBe(
      'agent-progress:implementer:2026-07-27T00:00:00Z:0',
    )
  })

  it('agentTypeがnullの場合はunknownを使う', () => {
    expect(buildEventId('subagent-skeleton', null, '2026-07-27T00:00:00Z', 3)).toBe(
      'subagent-skeleton:unknown:2026-07-27T00:00:00Z:3',
    )
  })

  it('同一秒・同一agentTypeでもlineIndexが異なれば衝突しない', () => {
    const a = buildEventId('agent-progress', 'implementer', '2026-07-27T00:00:00Z', 0)
    const b = buildEventId('agent-progress', 'implementer', '2026-07-27T00:00:00Z', 1)
    expect(a).not.toBe(b)
  })
})
