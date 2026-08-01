import { journalAdapter, type CanonicalEvent } from './canonical-event'

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
}

export function summarizeBlockedGates(events: CanonicalEvent[]): BlockedGateSummary {
  const blocked = events.filter((event) => event.source === 'journal' && event.status === 'blocked')
  const byAgentType: Record<string, number> = {}
  for (const event of blocked) {
    const key = event.agentType ?? 'unknown'
    byAgentType[key] = (byAgentType[key] ?? 0) + 1
  }
  return { totalBlocked: blocked.length, byAgentType }
}

function main() {
  const args = process.argv.slice(2)
  const getArg = (name: string, fallback: string) => {
    const index = args.indexOf(name)
    return index === -1 ? fallback : args[index + 1]
  }

  const projectDir = getArg(
    '--project-dir',
    `${process.env.HOME ?? ''}/.claude/projects/-Users-masanori-medical-inventory-vkumai`,
  )
  const asJson = args.includes('--json')

  const events = journalAdapter(projectDir).load()
  const summary = summarizeBlockedGates(events)

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2))
  } else if (summary.totalBlocked === 0) {
    console.log('blocked状態のWorkflow実行はありません（journal.jsonlベース）。')
  } else {
    console.log(`blocked状態のWorkflow実行: ${summary.totalBlocked}件（journal.jsonlベース。issue #569）`)
    const sorted = Object.entries(summary.byAgentType).sort((a, b) => b[1] - a[1])
    for (const [agentType, count] of sorted) {
      console.log(`  - ${agentType}: ${count}件`)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
