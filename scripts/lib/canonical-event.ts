import { readFileSync } from 'node:fs'

export type EventSource = 'subagent-skeleton' | 'journal' | 'agent-progress' | 'loop-observability'
export type EventStatus = 'pass' | 'fail' | 'blocked' | 'done' | 'failed' | 'running' | 'starting' | 'waiting'

export interface CanonicalEvent {
  eventId: string
  agentId: string | null
  agentType: string | null
  feature: string | null
  startTimestamp: string | null
  endTimestamp: string | null
  status: EventStatus | null
  detail: string | null
  intent: string | null
  scenario: string | null
  source: EventSource
}

// docs/agents/common.md「サブエージェント進捗の可視化（issue #18）」に列挙されている
// 進捗記録対象agentType一覧。verify-agent-progress-transcript.tsから本モジュールへ移設（issue #569）。
export const KNOWN_AGENT_TYPES = [
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
] as const

// 自己申告jsonlの--agentは「reviewer-correctness」「implementer-groupA」のように
// agentTypeへ役割サフィックスを付けた自由記述のため、既知agentType一覧との前方一致
// （区切りは'-'または完全一致）で復元する。
export function extractAgentType(selfAgentField: string): string | null {
  const candidates = KNOWN_AGENT_TYPES.filter(
    (type) => selfAgentField === type || selfAgentField.startsWith(`${type}-`),
  )
  if (candidates.length === 0) return null
  return candidates.reduce((longest, current) => (current.length > longest.length ? current : longest))
}

// 各log-*.shは秒精度タイムスタンプ(date -u +"%Y-%m-%dT%H:%M:%SZ")しか書かないため、
// 同一秒内の複数状態遷移がタイムスタンプだけでは衝突しうる。ログ生成側は無改修という前提のため、
// ファイル内の出現順インデックス(lineIndex)をキーに含めて一意性を保証する。
export function buildEventId(
  source: EventSource,
  agentType: string | null,
  timestamp: string,
  lineIndex: number,
): string {
  return `${source}:${agentType ?? 'unknown'}:${timestamp}:${lineIndex}`
}

export interface EventAdapter {
  source: EventSource
  load(): CanonicalEvent[]
}

interface SkeletonLine {
  timestamp: string
  hookEvent: string
  agentId: string
  agentType?: string
  lastAssistantMessage?: string
  intent?: string
}

function parseSkeletonLine(raw: string): SkeletonLine | null {
  try {
    return JSON.parse(raw) as SkeletonLine
  } catch {
    return null
  }
}

export function subagentSkeletonAdapter(logFile: string): EventAdapter {
  return {
    source: 'subagent-skeleton',
    load(): CanonicalEvent[] {
      let content: string
      try {
        content = readFileSync(logFile, 'utf-8')
      } catch {
        return []
      }
      const lines = content.split('\n').filter(Boolean)
      const events: CanonicalEvent[] = []
      lines.forEach((raw, lineIndex) => {
        const parsed = parseSkeletonLine(raw)
        if (!parsed) return
        const isStart = parsed.hookEvent === 'SubagentStart'
        const agentType = parsed.agentType ?? null
        events.push({
          eventId: buildEventId('subagent-skeleton', agentType, parsed.timestamp, lineIndex),
          agentId: parsed.agentId,
          agentType,
          feature: null,
          startTimestamp: isStart ? parsed.timestamp : null,
          endTimestamp: isStart ? null : parsed.timestamp,
          status: null,
          detail: parsed.lastAssistantMessage ?? null,
          intent: parsed.intent ?? null,
          scenario: null,
          source: 'subagent-skeleton',
        })
      })
      return events
    },
  }
}
