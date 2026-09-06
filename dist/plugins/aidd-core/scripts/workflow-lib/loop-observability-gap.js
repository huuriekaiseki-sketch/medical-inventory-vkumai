export function computeGap({ actualCount, expectedCount }) {
  return { actualCount, expectedCount, hasGap: actualCount !== expectedCount }
}

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
    console.error('Usage: loop-observability-gap.js --actual N --expected M')
    process.exit(1)
  }

  const result = computeGap({ actualCount, expectedCount })
  console.log(JSON.stringify(result))
  if (result.hasGap) {
    console.error(
      `WARNING: loop-observability記録漏れ（またはズレ）の可能性 (actual=${result.actualCount}, expected=${result.expectedCount})`,
    )
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
