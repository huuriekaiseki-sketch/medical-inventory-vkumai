import { describe, expect, it } from 'vitest'
import { summarizeBlockedGates, summarizePassFailGates } from './gate-effectiveness-summary'
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
  it('blockedが無い場合はtotalBlocked=0かつbyAgentTypeが空、登場agentTypeは全てneverBlockedに載る', () => {
    const events = [journalEvent({ status: 'pass' }), journalEvent({ status: 'fail' })]
    expect(summarizeBlockedGates(events)).toEqual({
      totalBlocked: 0,
      byAgentType: {},
      neverBlockedAgentTypes: ['implementer'],
    })
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
      neverBlockedAgentTypes: [],
    })
  })

  it('agentTypeがnullの場合はunknownに集計する', () => {
    const events = [journalEvent({ agentType: null, status: 'blocked' })]
    expect(summarizeBlockedGates(events)).toEqual({
      totalBlocked: 1,
      byAgentType: { unknown: 1 },
      neverBlockedAgentTypes: [],
    })
  })

  it('journal以外のsourceは対象外(agent-progress/loop-observabilityにはblockedという値自体が来ない前提だが、念のため隔離を確認)', () => {
    const events = [
      journalEvent({ status: 'blocked' }),
      { ...journalEvent({ status: 'blocked' }), source: 'agent-progress' } as CanonicalEvent,
    ]
    expect(summarizeBlockedGates(events)).toEqual({
      totalBlocked: 1,
      byAgentType: { implementer: 1 },
      neverBlockedAgentTypes: [],
    })
  })

  it('journalに実行記録があるがblockedが0件のagentTypeをneverBlockedAgentTypesとしてソート済みで返す', () => {
    const events = [
      journalEvent({ agentId: 'a1', agentType: 'spec-check', status: 'pass' }),
      journalEvent({ agentId: 'a2', agentType: 'manifest-check', status: 'pass' }),
      journalEvent({ agentId: 'a3', agentType: 'manifest-check', status: 'fail' }),
      journalEvent({ agentId: 'a4', agentType: 'integrator', status: 'blocked' }),
    ]
    expect(summarizeBlockedGates(events)).toEqual({
      totalBlocked: 1,
      byAgentType: { integrator: 1 },
      neverBlockedAgentTypes: ['manifest-check', 'spec-check'],
    })
  })

  it('neverBlockedの分母はjournalソースのみで、他ソースにしか登場しないagentTypeは含めない', () => {
    const events = [
      journalEvent({ agentType: 'spec-check', status: 'pass' }),
      { ...journalEvent({ agentType: 'sweep-ui', status: 'pass' }), source: 'agent-progress' } as CanonicalEvent,
    ]
    expect(summarizeBlockedGates(events)).toEqual({
      totalBlocked: 0,
      byAgentType: {},
      neverBlockedAgentTypes: ['spec-check'],
    })
  })

  it('statusがnullのjournalイベントも実行記録として分母に含める', () => {
    const events = [journalEvent({ agentType: 'coverage-check', status: null })]
    expect(summarizeBlockedGates(events)).toEqual({
      totalBlocked: 0,
      byAgentType: {},
      neverBlockedAgentTypes: ['coverage-check'],
    })
  })
})

describe('summarizePassFailGates', () => {
  it('journal由来イベントをagentType別にpass/fail/blocked集計する(issue #642)', () => {
    const events = [
      journalEvent({ agentId: 'a1', agentType: 'implementer', status: 'pass' }),
      journalEvent({ agentId: 'a2', agentType: 'implementer', status: 'fail' }),
      journalEvent({ agentId: 'a3', agentType: 'implementer', status: 'pass' }),
      journalEvent({ agentId: 'a4', agentType: 'reviewer', status: 'blocked' }),
    ]
    expect(summarizePassFailGates(events)).toEqual({
      totalEvents: 4,
      byAgentType: {
        implementer: { pass: 2, fail: 1, blocked: 0, other: 0 },
        reviewer: { pass: 0, fail: 0, blocked: 1, other: 0 },
      },
    })
  })

  it('journal以外のsourceは集計に混ぜない(自己申告の欠落誤読を持ち込まないため)', () => {
    const events = [
      journalEvent({ status: 'pass' }),
      { ...journalEvent({ status: 'pass' }), source: 'loop-observability' } as CanonicalEvent,
    ]
    expect(summarizePassFailGates(events).totalEvents).toBe(1)
  })

  it('pass/fail/blocked以外のstatus(null含む)はotherに数える', () => {
    const events = [
      journalEvent({ agentType: 'coverage-check', status: null }),
      journalEvent({ agentType: 'coverage-check', status: 'running' }),
    ]
    expect(summarizePassFailGates(events)).toEqual({
      totalEvents: 2,
      byAgentType: { 'coverage-check': { pass: 0, fail: 0, blocked: 0, other: 2 } },
    })
  })

  it('agentTypeがnullの場合はunknownに集計する', () => {
    const events = [journalEvent({ agentType: null, status: 'pass' })]
    expect(summarizePassFailGates(events).byAgentType).toEqual({
      unknown: { pass: 1, fail: 0, blocked: 0, other: 0 },
    })
  })

  it('イベントが空なら空サマリを返す', () => {
    expect(summarizePassFailGates([])).toEqual({ totalEvents: 0, byAgentType: {} })
  })
})
