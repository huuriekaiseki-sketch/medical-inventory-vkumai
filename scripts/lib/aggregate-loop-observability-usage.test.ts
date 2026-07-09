import { describe, expect, it } from 'vitest'
import {
  computeWindow,
  dedupeUsageEvents,
  matchUsage,
  computeCost,
  aggregate,
  type LoopObservabilityEntry,
  type UsageEvent,
} from './aggregate-loop-observability-usage'

function entry(overrides: Partial<LoopObservabilityEntry>): LoopObservabilityEntry {
  return {
    timestamp: '2026-07-08T00:30:00Z',
    loop: 'agentic',
    agent: 'implementer',
    feature: 'sample-feature',
    attempt: 1,
    model: 'claude-sonnet-5',
    tokens: null,
    costUsd: null,
    intent: 'テスト用ダミー意図',
    scenario: 'テスト用ダミーシナリオ',
    result: 'pass',
    reason: 'テスト用ダミー理由',
    ...overrides,
  }
}

function usage(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    timestamp: '2026-07-08T00:29:30.000Z',
    model: 'claude-sonnet-5',
    attributionAgent: 'implementer',
    requestId: 'req_1',
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...overrides,
  }
}

describe('computeWindow', () => {
  it('先頭レコードの窓開始はエポック0', () => {
    const entries = [entry({ feature: 'a', timestamp: '2026-07-08T00:30:00Z' })]
    const window = computeWindow(entries, 0)
    expect(window.start).toBe('1970-01-01T00:00:00.000Z')
    expect(window.end).toBe('2026-07-08T00:30:00Z')
  })

  it('同一feature内では直前レコードのtimestampが窓開始になる', () => {
    const entries = [
      entry({ feature: 'a', timestamp: '2026-07-08T00:10:00Z' }),
      entry({ feature: 'a', timestamp: '2026-07-08T00:30:00Z' }),
    ]
    const window = computeWindow(entries, 1)
    expect(window.start).toBe('2026-07-08T00:10:00Z')
    expect(window.end).toBe('2026-07-08T00:30:00Z')
  })

  it('featureが異なるレコードは窓計算に影響しない', () => {
    const entries = [
      entry({ feature: 'other', timestamp: '2026-07-08T00:05:00Z' }),
      entry({ feature: 'a', timestamp: '2026-07-08T00:30:00Z' }),
    ]
    const window = computeWindow(entries, 1)
    expect(window.start).toBe('1970-01-01T00:00:00.000Z')
  })
})

describe('dedupeUsageEvents', () => {
  it('同一requestIdは合計トークン数が最大のものを1件だけ残す', () => {
    const events = [
      usage({ requestId: 'req_1', outputTokens: 100 }),
      usage({ requestId: 'req_1', outputTokens: 500 }),
    ]
    const result = dedupeUsageEvents(events)
    expect(result).toHaveLength(1)
    expect(result[0].outputTokens).toBe(500)
  })
})

describe('matchUsage', () => {
  it('agent一致かつ窓内のイベントだけを返す', () => {
    const window = { start: '2026-07-08T00:00:00Z', end: '2026-07-08T00:30:00Z' }
    const events = [
      usage({ attributionAgent: 'implementer', timestamp: '2026-07-08T00:15:00.000Z' }),
      usage({ attributionAgent: 'reviewer', timestamp: '2026-07-08T00:15:00.000Z' }),
      usage({ attributionAgent: 'implementer', timestamp: '2026-07-08T00:45:00.000Z' }),
    ]
    const result = matchUsage(entry({ agent: 'implementer' }), window, events)
    expect(result).toHaveLength(1)
  })
})

describe('computeCost', () => {
  it('既知モデルのイベントからコストを計算する（timestampベースの単価判定を使う）', () => {
    const cost = computeCost([
      usage({
        model: 'claude-sonnet-5',
        timestamp: '2026-09-02T00:00:00.000Z',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ])
    expect(cost).toBeCloseTo(3 + 15, 5)
  })

  it('未知モデルが混ざっていたらnullを返す（過小評価しない）', () => {
    const cost = computeCost([usage({ model: 'unknown-model' })])
    expect(cost).toBeNull()
  })
})

describe('aggregate', () => {
  it('human/e2e-runnerはtranscript対象外としてスキップ集計する', () => {
    const entries = [entry({ agent: 'human' }), entry({ agent: 'e2e-runner' })]
    const result = aggregate(entries, [])
    expect(result.stats.skippedNoTarget).toBe(2)
    expect(result.updated[0].tokens).toBeNull()
    expect(result.updated[1].tokens).toBeNull()
  })

  it('突合できたレコードはtokens/costUsdが埋まり、他フィールドは変化しない', () => {
    const entries = [entry({ feature: 'a', agent: 'implementer', timestamp: '2026-07-08T00:30:00Z' })]
    const events = [usage({ attributionAgent: 'implementer', timestamp: '2026-07-08T00:15:00.000Z' })]
    const result = aggregate(entries, events)
    expect(result.stats.matched).toBe(1)
    expect(result.updated[0].tokens).toBe(1500)
    expect(result.updated[0].costUsd).not.toBeNull()
    expect(result.updated[0].intent).toBe(entries[0].intent)
  })

  it('窓内に一致するusageが無ければskippedNoUsageに計上する', () => {
    const entries = [entry({ feature: 'a', agent: 'implementer', timestamp: '2026-07-08T00:30:00Z' })]
    const result = aggregate(entries, [])
    expect(result.stats.skippedNoUsage).toBe(1)
    expect(result.updated[0].tokens).toBeNull()
  })
})
