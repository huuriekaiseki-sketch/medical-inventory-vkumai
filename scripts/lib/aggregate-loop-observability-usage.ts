import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

export function parseTranscriptLine(line: string): UsageEvent | null {
  let parsed: any
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  const usage = parsed?.message?.usage
  if (!usage || typeof usage.input_tokens !== 'number') return null
  return {
    timestamp: parsed.timestamp,
    model: parsed.message.model,
    attributionAgent: parsed.attributionAgent ?? null,
    requestId: parsed.requestId ?? parsed.uuid,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  }
}

function findJsonlFiles(root: string): string[] {
  const result: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
      } else if (name.endsWith('.jsonl')) {
        result.push(full)
      }
    }
  }
  walk(root)
  return result
}

export function loadUsageEventsFromTranscripts(projectsRoot: string): UsageEvent[] {
  const events: UsageEvent[] = []
  for (const file of findJsonlFiles(projectsRoot)) {
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
      const event = parseTranscriptLine(line)
      if (event) events.push(event)
    }
  }
  return events
}

export function loadLogEntries(logFilePath: string): LoopObservabilityEntry[] {
  const lines = readFileSync(logFilePath, 'utf-8').split('\n').filter(Boolean)
  return lines.map((line) => JSON.parse(line) as LoopObservabilityEntry)
}

export function writeLogEntries(logFilePath: string, entries: LoopObservabilityEntry[]): void {
  const content = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  writeFileSync(logFilePath, content, 'utf-8')
}

function main() {
  const logFilePath = process.argv[2] ?? 'logs/loop-observability.jsonl'
  const projectsRoot = process.argv[3] ?? join(process.env.HOME ?? '', '.claude/projects')

  const entries = loadLogEntries(logFilePath)
  const events = loadUsageEventsFromTranscripts(projectsRoot)
  const { updated, stats } = aggregate(entries, events)
  writeLogEntries(logFilePath, updated)

  console.log(
    `total=${stats.total} matched=${stats.matched} skippedNoTarget(human/e2e-runner)=${stats.skippedNoTarget} skippedNoUsage(突合失敗)=${stats.skippedNoUsage}`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
