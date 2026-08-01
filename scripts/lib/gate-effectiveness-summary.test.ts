import { describe, expect, it } from 'vitest'
import { summarizeBlockedGates } from './gate-effectiveness-summary'
import type { CanonicalEvent } from './canonical-event'

function journalEvent(overrides: Partial<CanonicalEvent>): CanonicalEvent {
  return {
    eventId: 'journal:x:2026-07-27T00:00:00Z:0',
    agentId: 'a1',
    agentType: 'implementer',
    feature: null,
    startTimestamp: null,
    endTimestamp: '2026-07-27T00:00:00Z',
    status: 'blocked',
    detail: null,
    intent: null,
    scenario: null,
    source: 'journal',
    ...overrides,
  }
}

describe('summarizeBlockedGates', () => {
  it('blockedが無い場合はtotalBlocked=0かつbyAgentTypeが空', () => {
    const events = [journalEvent({ status: 'pass' }), journalEvent({ status: 'fail' })]
    expect(summarizeBlockedGates(events)).toEqual({ totalBlocked: 0, byAgentType: {} })
  })

  it('blockedをagentType別に集計する', () => {
    const events = [
      journalEvent({ agentId: 'a1', agentType: 'implementer', status: 'blocked' }),
      journalEvent({ agentId: 'a2', agentType: 'implementer', status: 'blocked' }),
      journalEvent({ agentId: 'a3', agentType: 'reviewer', status: 'blocked' }),
      journalEvent({ agentId: 'a4', agentType: 'reviewer', status: 'pass' }),
    ]
    expect(summarizeBlockedGates(events)).toEqual({
      totalBlocked: 3,
      byAgentType: { implementer: 2, reviewer: 1 },
    })
  })

  it('agentTypeがnullの場合はunknownに集計する', () => {
    const events = [journalEvent({ agentType: null, status: 'blocked' })]
    expect(summarizeBlockedGates(events)).toEqual({ totalBlocked: 1, byAgentType: { unknown: 1 } })
  })

  it('journal以外のsourceは対象外(agent-progress/loop-observabilityにはblockedという値自体が来ない前提だが、念のため隔離を確認)', () => {
    const events = [
      journalEvent({ status: 'blocked' }),
      { ...journalEvent({ status: 'blocked' }), source: 'agent-progress' } as CanonicalEvent,
    ]
    expect(summarizeBlockedGates(events)).toEqual({ totalBlocked: 1, byAgentType: { implementer: 1 } })
  })
})
