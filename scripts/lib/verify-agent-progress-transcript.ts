import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadJournalResults, pairAgentFiles, parseAgentTranscriptLines } from './reconstruct-loop-observability'

// WHY: docs/agents/common.md「サブエージェント進捗の可視化（issue #18）」に列挙されている
//      進捗記録対象agentType一覧。ここに無い名前（Find/Adversarial Verify等の一部）はそもそも
//      進捗記録の対象外のため、突き合わせ対象からも自然に外れる。
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

export interface SelfReportRecord {
  timestamp: string
  agent: string
  feature: string
  status: string
  note: string
}

export interface TranscriptRecord {
  wfDir: string
  agentId: string
  agentType: string
  endTimestamp: string | null
  status: 'pass' | 'fail' | 'blocked' | null
  detail: string | null
}

// WHY: 自己申告jsonlの--agentは「reviewer-correctness」「implementer-groupA」のように
//      agentTypeへ役割サフィックスを付けた自由記述のため、transcript側のagentType（完全一致）と
//      直接は一致しない。既知agentType一覧との前方一致（区切りは'-'または完全一致）で復元する。
export function extractAgentType(selfAgentField: string): string | null {
  const candidates = KNOWN_AGENT_TYPES.filter(
    (type) => selfAgentField === type || selfAgentField.startsWith(`${type}-`),
  )
  if (candidates.length === 0) return null
  return candidates.reduce((longest, current) => (current.length > longest.length ? current : longest))
}

function toEpochMs(timestamp: string): number | null {
  const ms = Date.parse(timestamp)
  return Number.isNaN(ms) ? null : ms
}

export interface MatchedPair {
  self: SelfReportRecord
  transcript: TranscriptRecord
}

export interface MatchOutcome {
  matched: MatchedPair[]
  unmatchedSelf: SelfReportRecord[]
}

// WHY: agent-progress.jsonlはagentId/workflow実行IDを保持しないため、transcriptとの対応は
//      1:1のID突合ができない。同じagentType内で最も時刻が近いtranscriptに貪欲に割り当てる
//      ベストエフォート方式（許容誤差外・使用済みtranscriptは対象外）。高並行実行下では
//      誤対応の可能性が残ることをこの関数の利用側は認識すること。
export function matchRecords(
  selfReports: SelfReportRecord[],
  transcripts: TranscriptRecord[],
  toleranceMs = 30 * 60 * 1000,
): MatchOutcome {
  const usedTranscriptIndexes = new Set<number>()
  const matched: MatchedPair[] = []
  const unmatchedSelf: SelfReportRecord[] = []

  const sortedSelf = [...selfReports].sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  for (const self of sortedSelf) {
    const agentType = extractAgentType(self.agent)
    const selfEpoch = toEpochMs(self.timestamp)
    if (!agentType || selfEpoch === null) {
      unmatchedSelf.push(self)
      continue
    }

    let bestIndex = -1
    let bestDiff = Infinity
    transcripts.forEach((transcript, index) => {
      if (usedTranscriptIndexes.has(index)) return
      if (transcript.agentType !== agentType) return
      if (!transcript.endTimestamp) return
      const transcriptEpoch = toEpochMs(transcript.endTimestamp)
      if (transcriptEpoch === null) return
      const diff = Math.abs(transcriptEpoch - selfEpoch)
      if (diff <= toleranceMs && diff < bestDiff) {
        bestDiff = diff
        bestIndex = index
      }
    })

    if (bestIndex === -1) {
      unmatchedSelf.push(self)
    } else {
      usedTranscriptIndexes.add(bestIndex)
      matched.push({ self, transcript: transcripts[bestIndex] })
    }
  }

  return { matched, unmatchedSelf }
}

export type StatusComparison = 'match' | 'mismatch' | 'unknown'

// WHY: 自己申告は進捗ライフサイクル語彙(done/failed)、transcriptは成果語彙(pass/fail/blocked)で
//      語彙が異なる。「done」は成功系(pass/blocked)、「failed」は失敗(fail)に対応すると解釈する。
//      blockedは仕様確認待ち等の正常な停止でも起こりうるため、doneとの不一致とはみなさない。
export function compareStatus(selfStatus: string, transcriptStatus: 'pass' | 'fail' | 'blocked' | null): StatusComparison {
  if (transcriptStatus === null) return 'unknown'
  if (selfStatus === 'done') {
    return transcriptStatus === 'fail' ? 'mismatch' : 'match'
  }
  if (selfStatus === 'failed') {
    return transcriptStatus === 'pass' ? 'mismatch' : 'match'
  }
  return 'unknown'
}

export type DetailComparison = 'match' | 'low_overlap' | 'unknown'

function charBigrams(text: string): Set<string> {
  const normalized = text.replace(/\s+/g, '')
  const bigrams = new Set<string>()
  for (let i = 0; i < normalized.length - 1; i++) {
    bigrams.add(normalized.slice(i, i + 2))
  }
  return bigrams
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

// WHY: LLMを使わずに日本語の自由記述同士の関連度を見るため、文字bigramのJaccard類似度を使う
//      （分かち書き不要・軽量）。閾値未満は「低一致=要目視確認」という弱いシグナルに留め、
//      機械的な確定NG扱いにはしない（自己申告note・transcript detailは表現が違って当然のため）。
export const LOW_OVERLAP_THRESHOLD = 0.08

export function compareDetail(note: string, detail: string | null): DetailComparison {
  if (!detail || detail.trim().length === 0 || !note || note.trim().length === 0) return 'unknown'
  const similarity = jaccardSimilarity(charBigrams(note), charBigrams(detail))
  return similarity < LOW_OVERLAP_THRESHOLD ? 'low_overlap' : 'match'
}

export interface VerificationReportEntry {
  self: SelfReportRecord
  transcript: TranscriptRecord
  statusComparison: StatusComparison
  detailComparison: DetailComparison
}

export interface VerificationReport {
  totalSelfReports: number
  matchedCount: number
  unmatchedSelf: SelfReportRecord[]
  mismatches: VerificationReportEntry[]
  lowOverlapDetails: VerificationReportEntry[]
}

export function buildReport(
  selfReports: SelfReportRecord[],
  transcripts: TranscriptRecord[],
  toleranceMs?: number,
): VerificationReport {
  const { matched, unmatchedSelf } = matchRecords(selfReports, transcripts, toleranceMs)

  const entries: VerificationReportEntry[] = matched.map(({ self, transcript }) => ({
    self,
    transcript,
    statusComparison: compareStatus(self.status, transcript.status),
    detailComparison: compareDetail(self.note, transcript.detail),
  }))

  return {
    totalSelfReports: selfReports.length,
    matchedCount: matched.length,
    unmatchedSelf,
    mismatches: entries.filter((entry) => entry.statusComparison === 'mismatch'),
    lowOverlapDetails: entries.filter((entry) => entry.detailComparison === 'low_overlap'),
  }
}

export function loadSelfReports(logFilePath: string): SelfReportRecord[] {
  let content: string
  try {
    content = readFileSync(logFilePath, 'utf-8')
  } catch {
    return []
  }
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SelfReportRecord)
    .filter((record) => record.status === 'done' || record.status === 'failed')
}

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

export function loadTranscripts(projectDir: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = []
  for (const wfDir of findWorkflowDirs(projectDir)) {
    const filenames = readdirSync(wfDir)
    const pairs = pairAgentFiles(filenames)
    // issue #493: journal.jsonlにその agentId の構造化result（status/detail）があれば、
    // transcript最終メッセージのパース結果より優先して使う（endTimestampはjournal.jsonlに
    // タイムスタンプが無いため引き続きtranscript側から取得し、matchRecordsの時刻近接突合
    // ロジックには影響しない）。journal.jsonlが無い/該当agentIdが無い場合は従来どおり
    // transcriptパース結果のままフォールバックする。
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
      records.push({
        wfDir,
        agentId,
        agentType,
        endTimestamp: summary.endTimestamp,
        status: journalResult ? journalResult.status : summary.status,
        detail: journalResult ? journalResult.detail : summary.detail,
      })
    }
  }
  return records
}

function main() {
  const args = process.argv.slice(2)
  const getArg = (name: string, fallback: string) => {
    const index = args.indexOf(name)
    return index === -1 ? fallback : args[index + 1]
  }

  const logFilePath = getArg('--log-file', 'logs/agent-progress.jsonl')
  const projectDir = getArg(
    '--project-dir',
    join(process.env.HOME ?? '', '.claude/projects/-Users-masanori-medical-inventory-vkumai'),
  )
  const asJson = args.includes('--json')

  const selfReports = loadSelfReports(logFilePath)
  const transcripts = loadTranscripts(projectDir)
  const report = buildReport(selfReports, transcripts)

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(
      `自己申告(done/failed): ${report.totalSelfReports}件 / transcriptと突き合わせ成功: ${report.matchedCount}件 / 未対応(未突合): ${report.unmatchedSelf.length}件`,
    )
    if (report.mismatches.length > 0) {
      console.log(`\n食い違い(status): ${report.mismatches.length}件`)
      for (const entry of report.mismatches) {
        console.log(
          `  - agent=${entry.self.agent} feature=${entry.self.feature} 自己申告=${entry.self.status}(${entry.self.note}) transcript=${entry.transcript.status}(${entry.transcript.detail ?? ''})`,
        )
      }
    }
    if (report.lowOverlapDetails.length > 0) {
      console.log(`\ndetail低一致(要目視確認・弱いシグナル): ${report.lowOverlapDetails.length}件`)
      for (const entry of report.lowOverlapDetails) {
        console.log(
          `  - agent=${entry.self.agent} feature=${entry.self.feature} note="${entry.self.note}" detail="${entry.transcript.detail ?? ''}"`,
        )
      }
    }
  }

  if (report.mismatches.length > 0) {
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
