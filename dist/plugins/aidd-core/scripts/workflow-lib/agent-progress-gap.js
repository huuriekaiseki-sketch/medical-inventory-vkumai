// issue #339: loop-observability-gap.js と同一の差分検知ロジック（実測件数 vs 期待件数）を
// agent-progress記録の記録漏れ検知にも転用する。判定ロジック自体は共通なので再利用し、
// CLIのメッセージ文言のみagent-progress向けに分ける。
import { computeGap } from './loop-observability-gap.js'

export { computeGap }

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1]
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const actualCount = Number(args.actual)
  const expectedCount = Number(args.expected)
  if (!Number.isInteger(actualCount) || !Number.isInteger(expectedCount)) {
    console.error('Usage: agent-progress-gap.js --actual N --expected M')
    process.exit(1)
  }

  const result = computeGap({ actualCount, expectedCount })
  console.log(JSON.stringify(result))
  if (result.hasGap) {
    console.error(
      `WARNING: agent-progress記録漏れ（またはズレ）の可能性 (actual=${result.actualCount}, expected=${result.expectedCount})`,
    )
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
