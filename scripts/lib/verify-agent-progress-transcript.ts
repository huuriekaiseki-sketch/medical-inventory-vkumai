import { loadAllEvents, correlateEvents, type CanonicalEvent, type CorrelatedExecution } from './canonical-event.ts'

export type StatusComparison = 'match' | 'mismatch' | 'unknown'

// WHY: 自己申告は進捗ライフサイクル語彙(done/failed)、transcriptは成果語彙(pass/fail/blocked)で
//      語彙が異なる。「done」は成功系(pass/blocked)、「failed」は失敗(fail)に対応すると解釈する。
//      blockedは仕様確認待ち等の正常な停止でも起こりうるため、doneとの不一致とはみなさない。
export function compareStatus(selfStatus: string, anchorStatus: 'pass' | 'fail' | 'blocked' | null): StatusComparison {
  if (anchorStatus === null) return 'unknown'
  if (selfStatus === 'done') {
    return anchorStatus === 'fail' ? 'mismatch' : 'match'
  }
  if (selfStatus === 'failed') {
    return anchorStatus === 'pass' ? 'mismatch' : 'match'
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
  selfEvent: CanonicalEvent
  anchorEvent: CanonicalEvent
  statusComparison: StatusComparison
  detailComparison: DetailComparison
}

export interface VerificationReport {
  totalSelfReports: number
  matchedCount: number
  unmatchedSelf: CanonicalEvent[]
  mismatches: VerificationReportEntry[]
  lowOverlapDetails: VerificationReportEntry[]
}

// issue #569: 突合ロジック(agentId厳密一致 + agentType/時刻窓フォールバック)は
// canonical-event.tsのcorrelateEvents()へ移設した。ここでは正規化済みの
// CorrelatedExecution[]から、意味変換(status/detailの一致判定)とレポート整形のみを行う。
export function buildReport(correlated: CorrelatedExecution[]): VerificationReport {
  const entries: VerificationReportEntry[] = []
  const unmatchedSelf: CanonicalEvent[] = []
  let totalSelfReports = 0

  for (const exec of correlated) {
    const selfEvent = exec.events.find(
      (e) => e.source === 'agent-progress' && (e.status === 'done' || e.status === 'failed'),
    )
    if (!selfEvent) continue
    totalSelfReports += 1

    // WHY: journalはstatus/detailを持つがsubagent-skeletonはstatusが常にnull。
    //      同一execにsubagent-skeletonがjournalより先に積まれている場合(loadAllEventsの
    //      呼び出し順に依存)、単純な.findだとstatus=nullのsubagent-skeleton側を誤って
    //      拾いunmatchedSelfへ落ちてしまう(検証すべき食い違いを見逃すfalse negative)ため、
    //      journalを優先し無ければsubagent-skeletonへフォールバックする。
    const anchorEvent =
      exec.events.find((e) => e.source === 'journal') ?? exec.events.find((e) => e.source === 'subagent-skeleton')
    if (!anchorEvent || anchorEvent.status === null) {
      unmatchedSelf.push(selfEvent)
      continue
    }

    entries.push({
      selfEvent,
      anchorEvent,
      statusComparison: compareStatus(selfEvent.status ?? '', anchorEvent.status as 'pass' | 'fail' | 'blocked'),
      detailComparison: compareDetail(selfEvent.detail ?? '', anchorEvent.detail),
    })
  }

  return {
    totalSelfReports,
    matchedCount: entries.length,
    unmatchedSelf,
    mismatches: entries.filter((entry) => entry.statusComparison === 'mismatch'),
    lowOverlapDetails: entries.filter((entry) => entry.detailComparison === 'low_overlap'),
  }
}

function main() {
  const args = process.argv.slice(2)
  const getArg = (name: string, fallback: string) => {
    const index = args.indexOf(name)
    return index === -1 ? fallback : args[index + 1]
  }

  const agentProgressLogFile = getArg('--log-file', 'logs/agent-progress.jsonl')
  const subagentSkeletonLogFile = getArg('--skeleton-log-file', 'logs/subagent-skeleton.jsonl')
  const projectDir = getArg(
    '--project-dir',
    `${process.env.HOME ?? ''}/.claude/projects/-Users-masanori-medical-inventory-vkumai`,
  )
  const asJson = args.includes('--json')

  const events = loadAllEvents({ agentProgressLogFile, subagentSkeletonLogFile, projectDir })
  const correlated = correlateEvents(events)
  const report = buildReport(correlated)

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(
      `自己申告(done/failed): ${report.totalSelfReports}件 / 突合成功: ${report.matchedCount}件 / 未対応(未突合): ${report.unmatchedSelf.length}件`,
    )
    if (report.mismatches.length > 0) {
      console.log(`\n食い違い(status): ${report.mismatches.length}件`)
      for (const entry of report.mismatches) {
        console.log(
          `  - agentType=${entry.selfEvent.agentType} feature=${entry.selfEvent.feature} 自己申告=${entry.selfEvent.status}(${entry.selfEvent.detail}) anchor=${entry.anchorEvent.status}(${entry.anchorEvent.detail ?? ''})`,
        )
      }
    }
    if (report.lowOverlapDetails.length > 0) {
      console.log(`\ndetail低一致(要目視確認・弱いシグナル): ${report.lowOverlapDetails.length}件`)
      for (const entry of report.lowOverlapDetails) {
        console.log(
          `  - agentType=${entry.selfEvent.agentType} feature=${entry.selfEvent.feature} note="${entry.selfEvent.detail}" detail="${entry.anchorEvent.detail ?? ''}"`,
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
