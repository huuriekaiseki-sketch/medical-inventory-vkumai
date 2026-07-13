import { readdirSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getPricing } from './model-pricing'

// WHY: reviewer/judge-panelはscripts/log-loop-observability.shを`--loop developer`明示で呼ぶ設計、
//      implementer等それ以外はスクリプトのデフォルト値`agentic`に依存する設計だった（docs/agents/*.md参照）。
//      transcriptには元の--loop引数値自体は残らないため、agentTypeからこの既存の呼び分けを再現する。
const DEVELOPER_LOOP_AGENT_TYPES = new Set(['reviewer', 'judge-panel'])

export function mapAgentTypeToLoop(agentType: string): 'agentic' | 'developer' {
  return DEVELOPER_LOOP_AGENT_TYPES.has(agentType) ? 'developer' : 'agentic'
}

export interface Finding {
  severity: string
  description: string
}

export interface AgentTranscriptSummary {
  model: string | null
  startTimestamp: string | null
  endTimestamp: string | null
  tokens: number
  costUsd: number | null
  status: 'pass' | 'fail' | 'blocked' | null
  detail: string | null
  findings: Finding[] | null
  promptText: string | null
}

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface RawContentBlock {
  type?: string
  name?: string
  text?: string
  input?: { status?: string; detail?: string; findings?: Finding[] }
}

interface RawLine {
  type?: string
  timestamp?: string
  message?: {
    role?: string
    model?: string
    content?: string | RawContentBlock[]
    usage?: RawUsage
  }
}

function parseLine(line: string): RawLine | null {
  try {
    return JSON.parse(line) as RawLine
  } catch {
    return null
  }
}

export function parseAgentTranscriptLines(lines: string[]): AgentTranscriptSummary {
  let promptText: string | null = null
  let startTimestamp: string | null = null
  let endTimestamp: string | null = null
  let model: string | null = null
  let tokens = 0
  let costUsd = 0
  let costUnknown = false
  let status: AgentTranscriptSummary['status'] = null
  let detail: string | null = null
  let findings: Finding[] | null = null
  let lastTimestamp: string | null = null

  for (const raw of lines) {
    const parsed = parseLine(raw)
    if (!parsed) continue
    if (parsed.timestamp) lastTimestamp = parsed.timestamp

    if (promptText === null && parsed.type === 'user' && typeof parsed.message?.content === 'string') {
      promptText = parsed.message.content
      startTimestamp = parsed.timestamp ?? null
    }

    if (parsed.type === 'assistant' && parsed.message) {
      if (parsed.message.model) model = parsed.message.model

      const usage = parsed.message.usage
      if (usage) {
        tokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
        if (!costUnknown) {
          const pricing = getPricing(parsed.message.model ?? '', parsed.timestamp)
          if (!pricing) {
            costUnknown = true
          } else {
            costUsd +=
              ((usage.input_tokens ?? 0) / 1_000_000) * pricing.inputPerMTok +
              ((usage.output_tokens ?? 0) / 1_000_000) * pricing.outputPerMTok +
              ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * pricing.cacheWritePerMTok +
              ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * pricing.cacheReadPerMTok
          }
        }
      }

      const blocks = Array.isArray(parsed.message.content) ? parsed.message.content : []
      const structuredOutput = blocks.find((b) => b.type === 'tool_use' && b.name === 'StructuredOutput')
      if (structuredOutput?.input) {
        status = (structuredOutput.input.status as AgentTranscriptSummary['status']) ?? null
        detail = structuredOutput.input.detail ?? null
        findings = structuredOutput.input.findings ?? null
        endTimestamp = parsed.timestamp ?? endTimestamp
      }
    }
  }

  if (endTimestamp === null) endTimestamp = lastTimestamp

  return {
    model,
    startTimestamp,
    endTimestamp,
    tokens,
    costUsd: costUnknown ? null : costUsd,
    status,
    detail,
    findings,
    promptText,
  }
}

export function assignAttempts<T extends { agentType: string; startTimestamp: string | null }>(
  records: T[],
): (T & { attempt: number })[] {
  const byType = new Map<string, T[]>()
  for (const record of records) {
    const bucket = byType.get(record.agentType) ?? []
    bucket.push(record)
    byType.set(record.agentType, bucket)
  }

  const attemptByRecord = new Map<T, number>()
  for (const bucket of byType.values()) {
    const sorted = [...bucket].sort((a, b) => (a.startTimestamp ?? '').localeCompare(b.startTimestamp ?? ''))
    sorted.forEach((record, index) => attemptByRecord.set(record, index + 1))
  }

  return records.map((record) => ({ ...record, attempt: attemptByRecord.get(record) ?? 1 }))
}

const INTENT_UNKNOWN = '(transcriptから復元: プロンプト不明)'

export function deriveIntent(promptText: string | null): string {
  if (promptText === null) return INTENT_UNKNOWN
  const firstLine = promptText.split('\n')[0]?.trim() ?? ''
  return firstLine.length > 0 ? firstLine : INTENT_UNKNOWN
}

const SCENARIO_UNKNOWN = '(transcriptから復元: scenario情報は失われている)'
const MAX_REASON_LENGTH = 300

export function pairAgentFiles(filenames: string[]): { agentId: string; jsonlFile: string; metaFile: string }[] {
  const jsonlFiles = new Set(filenames.filter((f) => /^agent-.+\.jsonl$/.test(f)))
  const metaFiles = new Set(filenames.filter((f) => /^agent-.+\.meta\.json$/.test(f)))

  const pairs: { agentId: string; jsonlFile: string; metaFile: string }[] = []
  for (const jsonlFile of jsonlFiles) {
    const agentId = jsonlFile.replace(/^agent-/, '').replace(/\.jsonl$/, '')
    const metaFile = `agent-${agentId}.meta.json`
    if (metaFiles.has(metaFile)) {
      pairs.push({ agentId, jsonlFile, metaFile })
    }
  }
  return pairs
}

export interface LoopObservabilityEntry {
  timestamp: string
  loop: string
  agent: string
  feature: string
  attempt: number
  model: string | null
  tokens: number
  costUsd: number | null
  intent: string
  scenario: string
  result: string
  reason: string
  reconstructed: true
}

export function buildLoopObservabilityEntry(params: {
  agentType: string
  feature: string
  attempt: number
  summary: AgentTranscriptSummary
}): LoopObservabilityEntry {
  const { agentType, feature, attempt, summary } = params
  const timestamp = summary.endTimestamp ?? summary.startTimestamp ?? ''
  const reason = summary.detail
    ? summary.detail.length > MAX_REASON_LENGTH
      ? `${summary.detail.slice(0, MAX_REASON_LENGTH)}…`
      : summary.detail
    : '(transcriptから復元: detail不明)'

  return {
    timestamp,
    loop: mapAgentTypeToLoop(agentType),
    agent: agentType,
    feature,
    attempt,
    model: summary.model,
    tokens: summary.tokens,
    costUsd: summary.costUsd,
    intent: deriveIntent(summary.promptText),
    scenario: SCENARIO_UNKNOWN,
    result: summary.status ?? 'unknown',
    reason,
    reconstructed: true,
  }
}

interface WorkflowAgentMeta {
  agentType?: string
}

export function reconstructWorkflowDir(wfDirPath: string, feature: string): LoopObservabilityEntry[] {
  const filenames = readdirSync(wfDirPath)
  const pairs = pairAgentFiles(filenames)

  const parsed = pairs.map(({ agentId, jsonlFile, metaFile }) => {
    const meta = JSON.parse(readFileSync(join(wfDirPath, metaFile), 'utf-8')) as WorkflowAgentMeta
    const lines = readFileSync(join(wfDirPath, jsonlFile), 'utf-8').split('\n').filter(Boolean)
    const summary = parseAgentTranscriptLines(lines)
    return { agentId, agentType: meta.agentType ?? 'unknown', startTimestamp: summary.startTimestamp, summary }
  })

  const withAttempts = assignAttempts(parsed)

  return withAttempts.map((record) =>
    buildLoopObservabilityEntry({
      agentType: record.agentType,
      feature,
      attempt: record.attempt,
      summary: record.summary,
    }),
  )
}

function main() {
  const wfDirPath = process.argv[2]
  const feature = process.argv[3] ?? 'unknown'
  const logFilePath = process.argv[4] ?? 'logs/loop-observability.jsonl'

  if (!wfDirPath) {
    console.error('Usage: reconstruct-loop-observability.ts <wfDirPath> [feature] [logFilePath]')
    process.exit(1)
  }

  const entries = reconstructWorkflowDir(wfDirPath, feature)
  mkdirSync(join(logFilePath, '..'), { recursive: true })
  const content = entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : '')
  appendFileSync(logFilePath, content, 'utf-8')
  console.log(`${entries.length}件のレコードを${logFilePath}に再構築しました`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
