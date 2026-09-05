import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
// 拡張子付き import: Node 標準の型除去で直接実行するため（harvest-journal-events.ts のコメント参照）
import { journalAdapter, type CanonicalEvent } from './canonical-event.ts'
import { loadHarvestedEvents } from './harvest-journal-events.ts'

// WHY: issue #569の残タスクのうち「サマリー・復旧処理をcanonical event Module経由に寄せる」を
// 部分的に実装する。summarize-loop-observability.sh（logs/loop-observability.jsonlのみ参照）は
// 自己申告(pass/fail)しか集計できず、`blocked`状態（aidd-phase2.jsのSpec Check/Manifest Check等が
// 返す）はこのログに一切記録されないため、月次品質ゲートサマリ（gate-effectiveness-monthly-check.sh、
// issue #412）から常に欠落していた（scripts/summarize-loop-observability.sh:45のコメント参照）。
// journalAdapter（canonical-event.ts）はWorkflow journal.jsonlからblockedを含むstatusを既に
// 正規化済みのため、ここではその再利用のみ行い、複雑なcorrelateEvents()の突合は行わない
// （blockedの有無・件数を数えるだけならagentId単位の相関は不要なため、issue #569コメントが
// 推奨した「スコープを絞った小さい一歩」に留める）。

export interface BlockedGateSummary {
  totalBlocked: number
  byAgentType: Record<string, number>
  // journalに実行記録が1件以上あるがblockedが0件のagentType一覧（issue #640）。
  // 分母をjournalソースに限定するのは、agent-progress等の他ソースにはblockedという
  // 値自体が存在せず、混ぜると「発火しようがないagentType」がノイズとして並ぶため。
  neverBlockedAgentTypes: string[]
}

export function summarizeBlockedGates(events: CanonicalEvent[]): BlockedGateSummary {
  const journalEvents = events.filter((event) => event.source === 'journal')
  const blocked = journalEvents.filter((event) => event.status === 'blocked')
  const byAgentType: Record<string, number> = {}
  for (const event of blocked) {
    const key = event.agentType ?? 'unknown'
    byAgentType[key] = (byAgentType[key] ?? 0) + 1
  }
  const seenAgentTypes = new Set(journalEvents.map((event) => event.agentType ?? 'unknown'))
  const neverBlockedAgentTypes = [...seenAgentTypes]
    .filter((agentType) => !(agentType in byAgentType))
    .sort()
  return { totalBlocked: blocked.length, byAgentType, neverBlockedAgentTypes }
}

// issue #642: 月次サマリのagent別pass/fail集計をjournalベースへ移行するための集計。
// loop-observability.jsonl(自己申告。記録漏れ＝欠落があり得る)と異なり、journalは
// Workflowランタイムの機械記録なので、欠落を「発火ゼロ」と誤読する問題が起きない。
export interface PassFailGateCounts {
  pass: number
  fail: number
  blocked: number
  other: number
}

export interface PassFailGateSummary {
  totalEvents: number
  byAgentType: Record<string, PassFailGateCounts>
}

export function summarizePassFailGates(events: CanonicalEvent[]): PassFailGateSummary {
  const journalEvents = events.filter((event) => event.source === 'journal')
  const byAgentType: Record<string, PassFailGateCounts> = {}
  for (const event of journalEvents) {
    const key = event.agentType ?? 'unknown'
    const counts = (byAgentType[key] ??= { pass: 0, fail: 0, blocked: 0, other: 0 })
    if (event.status === 'pass' || event.status === 'fail' || event.status === 'blocked') {
      counts[event.status] += 1
    } else {
      counts.other += 1
    }
  }
  return { totalEvents: journalEvents.length, byAgentType }
}

function main() {
  const args = process.argv.slice(2)
  const getArg = (name: string, fallback: string) => {
    const index = args.indexOf(name)
    return index === -1 ? fallback : args[index + 1]
  }

  // WHY（issue #420 v1）: 以前は個人環境のプロジェクトディレクトリ名を直書きしていた。cwd から導出する
  // （Claude Code は cwd の '/' と '.' を '-' に置き換えた名前を使う）
  const projectDir = getArg(
    '--project-dir',
    `${process.env.HOME ?? ''}/.claude/projects/${process.cwd().replace(/[/.]/g, '-')}`,
  )
  // --harvest-file指定時は収穫済みJSONL(logs/journal-harvest.jsonl)を読む。
  // 未指定時は従来どおりwf_*ディレクトリを直接読む(残存分のみ)。
  const harvestFile = getArg('--harvest-file', '')
  const asJson = args.includes('--json')

  const events = harvestFile ? loadHarvestedEvents(harvestFile) : journalAdapter(projectDir).load()
  const passFail = summarizePassFailGates(events)
  const blocked = summarizeBlockedGates(events)

  if (asJson) {
    console.log(JSON.stringify({ passFail, blocked }, null, 2))
    return
  }

  const sourceLabel = harvestFile ? `収穫済みjournal: ${harvestFile}` : 'journal.jsonl(残存wf_*のみ)'
  if (passFail.totalEvents === 0) {
    console.log(`Workflow実行記録がありません（${sourceLabel}）。`)
    return
  }
  console.log(`Workflow実行記録: ${passFail.totalEvents}件（${sourceLabel}。issue #642）`)
  const sorted = Object.entries(passFail.byAgentType).sort(
    (a, b) => b[1].pass + b[1].fail + b[1].blocked + b[1].other - (a[1].pass + a[1].fail + a[1].blocked + a[1].other),
  )
  for (const [agentType, counts] of sorted) {
    console.log(`  - ${agentType}: pass=${counts.pass} / fail=${counts.fail} / blocked=${counts.blocked}${counts.other > 0 ? ` / other=${counts.other}` : ''}`)
  }
  if (blocked.neverBlockedAgentTypes.length > 0) {
    console.log(`一度もblockedを返していないagentType（journalに実行記録あり。issue #640）:`)
    for (const agentType of blocked.neverBlockedAgentTypes) {
      console.log(`  - ${agentType}`)
    }
  }
}

// WHY: 単純な`file://${argv[1]}`比較だと、argv[1]がsymlink経由のパス
// (例: macOSの/var/folders→/private/var/folders)のときimport.meta.url(実パス)と
// 一致せずmain()が無言でスキップされる(issue #642のテストで発覚)。realpathで正規化する。
function isRunAsCli(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}

if (isRunAsCli()) {
  main()
}
