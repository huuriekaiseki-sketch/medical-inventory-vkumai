import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadJournalResults, pairAgentFiles, parseAgentTranscriptLines } from './reconstruct-loop-observability'

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
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // JSONパースに失敗した行は無言でスキップする（ログファイルに混在する非JSON行を許容）
    return null
  }
  // オブジェクトでない、またはnullの場合はスキップ
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as Record<string, unknown>
  // 必須フィールド（timestamp, hookEvent, agentId）の型検証
  // これらが欠落していたり型が異なる場合は、このレコードは無効なため無言でスキップ
  if (
    typeof candidate.timestamp !== 'string' ||
    typeof candidate.hookEvent !== 'string' ||
    typeof candidate.agentId !== 'string'
  ) {
    return null
  }
  return candidate as unknown as SkeletonLine
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

interface AgentProgressLine {
  timestamp: string
  agent: string
  feature: string
  status: string
  note: string
}

export function loadAllAgentProgressRecords(logFile: string): AgentProgressLine[] {
  let content: string
  try {
    content = readFileSync(logFile, 'utf-8')
  } catch {
    return []
  }
  return content
    .split('\n')
    .filter(Boolean)
    .map((raw) => JSON.parse(raw) as AgentProgressLine)
}

export function agentProgressAdapter(logFile: string): EventAdapter {
  return {
    source: 'agent-progress',
    load(): CanonicalEvent[] {
      return loadAllAgentProgressRecords(logFile).map((record, lineIndex) => {
        const agentType = extractAgentType(record.agent)
        return {
          eventId: buildEventId('agent-progress', agentType, record.timestamp, lineIndex),
          agentId: null,
          agentType,
          feature: record.feature,
          startTimestamp: null,
          endTimestamp: record.timestamp,
          status: record.status as EventStatus,
          detail: record.note,
          intent: null,
          scenario: null,
          source: 'agent-progress',
        }
      })
    },
  }
}

interface LoopObservabilityLine {
  timestamp: string
  agent: string
  feature: string
  intent: string
  scenario: string
  result: string
  reason: string
}

export function loadAllLoopObservabilityRecords(logFile: string): LoopObservabilityLine[] {
  let content: string
  try {
    content = readFileSync(logFile, 'utf-8')
  } catch {
    return []
  }
  return content
    .split('\n')
    .filter(Boolean)
    .map((raw) => JSON.parse(raw) as LoopObservabilityLine)
}

export function loopObservabilityAdapter(logFile: string): EventAdapter {
  return {
    source: 'loop-observability',
    load(): CanonicalEvent[] {
      return loadAllLoopObservabilityRecords(logFile).map((record, lineIndex) => {
        const agentType = extractAgentType(record.agent)
        return {
          eventId: buildEventId('loop-observability', agentType, record.timestamp, lineIndex),
          agentId: null,
          agentType,
          feature: record.feature,
          startTimestamp: null,
          endTimestamp: record.timestamp,
          status: record.result as EventStatus,
          detail: record.reason,
          intent: record.intent,
          scenario: record.scenario,
          source: 'loop-observability',
        }
      })
    },
  }
}

// 既存verify-agent-progress-transcript.tsのfindWorkflowDirsと同一ロジック。
// wf_*という名前のディレクトリを再帰的に探索する。
function findWorkflowDirs(projectDir: string): string[] {
  const results: string[] = []
  function walk(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      if (entry.startsWith('wf_')) {
        results.push(fullPath)
        continue
      }
      walk(fullPath)
    }
  }
  walk(projectDir)
  return results
}

export function journalAdapter(projectDir: string): EventAdapter {
  return {
    source: 'journal',
    load(): CanonicalEvent[] {
      const events: CanonicalEvent[] = []
      let lineIndex = 0
      for (const wfDir of findWorkflowDirs(projectDir)) {
        const filenames = readdirSync(wfDir)
        const pairs = pairAgentFiles(filenames)
        const journalResults = loadJournalResults(wfDir, filenames)
        for (const { agentId, jsonlFile, metaFile } of pairs) {
          let agentType = 'unknown'
          try {
            const meta = JSON.parse(readFileSync(join(wfDir, metaFile), 'utf-8')) as { agentType?: string }
            agentType = meta.agentType ?? 'unknown'
          } catch {
            continue
          }
          const lines = readFileSync(join(wfDir, jsonlFile), 'utf-8').split('\n').filter(Boolean)
          const summary = parseAgentTranscriptLines(lines)
          const journalResult = journalResults.get(agentId)
          const status = journalResult ? journalResult.status : summary.status
          const detail = journalResult ? journalResult.detail : summary.detail

          events.push({
            eventId: buildEventId('journal', agentType, summary.endTimestamp ?? 'unknown', lineIndex++),
            agentId,
            agentType,
            feature: null,
            startTimestamp: summary.startTimestamp,
            endTimestamp: summary.endTimestamp,
            status,
            detail,
            intent: null,
            scenario: null,
            source: 'journal',
          })
        }
      }
      return events
    },
  }
}

export interface LoadAllEventsOptions {
  subagentSkeletonLogFile?: string
  agentProgressLogFile?: string
  loopObservabilityLogFile?: string
  projectDir?: string
}

export function loadAllEvents(opts: LoadAllEventsOptions = {}): CanonicalEvent[] {
  const events: CanonicalEvent[] = []
  if (opts.subagentSkeletonLogFile) events.push(...subagentSkeletonAdapter(opts.subagentSkeletonLogFile).load())
  if (opts.agentProgressLogFile) events.push(...agentProgressAdapter(opts.agentProgressLogFile).load())
  if (opts.loopObservabilityLogFile) events.push(...loopObservabilityAdapter(opts.loopObservabilityLogFile).load())
  if (opts.projectDir) events.push(...journalAdapter(opts.projectDir).load())
  return events
}

export interface CorrelatedExecution {
  agentId: string
  events: CanonicalEvent[]
}

const DEFAULT_TOLERANCE_MS = 30 * 60 * 1000

function toEpochMs(timestamp: string): number | null {
  const ms = Date.parse(timestamp)
  return Number.isNaN(ms) ? null : ms
}

const TERMINAL_AGENT_PROGRESS_STATUSES = new Set(['done', 'failed'])

// agent-progressの中間状態(starting/running/waiting)は突合対象にしない。
// 既存loadSelfReports(verify-agent-progress-transcript.ts)がdone/failedのみを検証対象として
// きたのを踏襲する意図的な仕様(docs/superpowers/specs/2026-07-27-canonical-event-module-design.md参照)。
function isMatchTarget(event: CanonicalEvent): boolean {
  if (event.source === 'agent-progress') return TERMINAL_AGENT_PROGRESS_STATUSES.has(event.status ?? '')
  return true
}

export function correlateEvents(events: CanonicalEvent[], toleranceMs = DEFAULT_TOLERANCE_MS): CorrelatedExecution[] {
  const executions = new Map<string, CorrelatedExecution>()
  const selfReportEvents: CanonicalEvent[] = []

  // Stage 1: agentIdを持つイベント(subagent-skeleton/journal)を厳密一致でグループ化する。
  // 両者は同一agentId空間であることを実機検証済み(2026-07-27、docs/superpowers/specs/
  // 2026-07-27-canonical-event-module-design.md参照)。
  for (const event of events) {
    if (event.agentId !== null) {
      const existing = executions.get(event.agentId)
      if (existing) {
        existing.events.push(event)
      } else {
        executions.set(event.agentId, { agentId: event.agentId, events: [event] })
      }
    } else {
      selfReportEvents.push(event)
    }
  }

  // アンカー(agentId確定済みグループ)のagentType/endTimestamp代表値を算出する。
  interface AnchorInfo {
    agentId: string
    agentType: string | null
    endTimestamp: string | null
  }
  const anchorInfos: AnchorInfo[] = [...executions.entries()].map(([agentId, exec]) => {
    const withEndTs = exec.events.find((e) => e.endTimestamp !== null)
    return {
      agentId,
      agentType: withEndTs?.agentType ?? exec.events[0]?.agentType ?? null,
      endTimestamp: withEndTs?.endTimestamp ?? null,
    }
  })

  // Stage 2: ソースごとに独立した排他プールで、agentType一致・時刻窓内の最近傍アンカーへ貪欲割当する。
  // 排他制御を「ソース×agentType」単位にスコープすることで、agent-progressとloop-observabilityの
  // 両方が同じアンカーに対応付くこと自体は許容する(別ソースなので競合しない)。
  const bySource = new Map<EventSource, CanonicalEvent[]>()
  for (const event of selfReportEvents) {
    if (!isMatchTarget(event)) continue
    const bucket = bySource.get(event.source) ?? []
    bucket.push(event)
    bySource.set(event.source, bucket)
  }

  const matchedEventIds = new Set<string>()

  for (const candidates of bySource.values()) {
    const usedAgentIds = new Set<string>()
    const sorted = [...candidates].sort((a, b) => (a.endTimestamp ?? '').localeCompare(b.endTimestamp ?? ''))

    for (const candidate of sorted) {
      if (candidate.agentType === null || candidate.endTimestamp === null) continue
      const candidateEpoch = toEpochMs(candidate.endTimestamp)
      if (candidateEpoch === null) continue

      let bestAgentId: string | null = null
      let bestDiff = Infinity
      for (const anchor of anchorInfos) {
        if (usedAgentIds.has(anchor.agentId)) continue
        if (anchor.agentType !== candidate.agentType || anchor.endTimestamp === null) continue
        const anchorEpoch = toEpochMs(anchor.endTimestamp)
        if (anchorEpoch === null) continue
        const diff = Math.abs(anchorEpoch - candidateEpoch)
        if (diff <= toleranceMs && diff < bestDiff) {
          bestDiff = diff
          bestAgentId = anchor.agentId
        }
      }

      if (bestAgentId !== null) {
        usedAgentIds.add(bestAgentId)
        executions.get(bestAgentId)!.events.push(candidate)
        matchedEventIds.add(candidate.eventId)
      }
    }
  }

  // 突合対象外(中間状態)、または対応するアンカーが見つからなかった自己申告は単独扱いにする。
  for (const event of selfReportEvents) {
    if (matchedEventIds.has(event.eventId)) continue
    executions.set(event.eventId, { agentId: event.eventId, events: [event] })
  }

  return [...executions.values()]
}
