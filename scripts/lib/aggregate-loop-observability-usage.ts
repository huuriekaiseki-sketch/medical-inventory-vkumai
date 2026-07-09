import { getPricing } from './model-pricing'

export interface LoopObservabilityEntry {
  timestamp: string
  loop: string
  agent: string
  feature: string
  attempt: number
  model: string | null
  tokens: number | null
  costUsd: number | null
  intent: string
  scenario: string
  result: string
  reason: string
}

export interface UsageEvent {
  timestamp: string
  model: string
  attributionAgent: string | null
  requestId: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

const NO_TRANSCRIPT_AGENTS = new Set(['human', 'e2e-runner'])
const EPOCH = '1970-01-01T00:00:00.000Z'

export function computeWindow(
  entries: LoopObservabilityEntry[],
  index: number,
): { start: string; end: string } {
  const target = entries[index]
  let start = EPOCH
  for (let i = index - 1; i >= 0; i--) {
    if (entries[i].feature === target.feature) {
      start = entries[i].timestamp
      break
    }
  }
  return { start, end: target.timestamp }
}

export function dedupeUsageEvents(events: UsageEvent[]): UsageEvent[] {
  const byRequestId = new Map<string, UsageEvent>()
  for (const event of events) {
    const existing = byRequestId.get(event.requestId)
    const total = event.inputTokens + event.outputTokens
    const existingTotal = existing ? existing.inputTokens + existing.outputTokens : -1
    if (!existing || total > existingTotal) {
      byRequestId.set(event.requestId, event)
    }
  }
  return [...byRequestId.values()]
}

export function matchUsage(
  entry: LoopObservabilityEntry,
  window: { start: string; end: string },
  events: UsageEvent[],
): UsageEvent[] {
  return events.filter(
    (event) =>
      event.attributionAgent === entry.agent &&
      event.timestamp > window.start &&
      event.timestamp <= window.end,
  )
}

export function computeCost(events: UsageEvent[]): number | null {
  let total = 0
  for (const event of events) {
    const pricing = getPricing(event.model, event.timestamp)
    if (!pricing) return null
    total +=
      (event.inputTokens / 1_000_000) * pricing.inputPerMTok +
      (event.outputTokens / 1_000_000) * pricing.outputPerMTok +
      (event.cacheCreationInputTokens / 1_000_000) * pricing.cacheWritePerMTok +
      (event.cacheReadInputTokens / 1_000_000) * pricing.cacheReadPerMTok
  }
  return total
}

export function aggregate(
  entries: LoopObservabilityEntry[],
  rawEvents: UsageEvent[],
): {
  updated: LoopObservabilityEntry[]
  stats: { total: number; matched: number; skippedNoTarget: number; skippedNoUsage: number }
} {
  const events = dedupeUsageEvents(rawEvents)
  const stats = { total: entries.length, matched: 0, skippedNoTarget: 0, skippedNoUsage: 0 }

  const updated = entries.map((entry, index) => {
    if (NO_TRANSCRIPT_AGENTS.has(entry.agent)) {
      stats.skippedNoTarget++
      return entry
    }
    const window = computeWindow(entries, index)
    const matched = matchUsage(entry, window, events)
    if (matched.length === 0) {
      stats.skippedNoUsage++
      return entry
    }
    const tokens = matched.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0)
    const costUsd = computeCost(matched)
    stats.matched++
    return { ...entry, tokens, costUsd }
  })

  return { updated, stats }
}
