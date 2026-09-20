// issue #339: loop-observability-gap.js と同一の差分検知ロジック（実測件数 vs 期待件数）を
// agent-progress記録の記録漏れ検知にも転用する。判定ロジック自体は共通なので再利用し、
// CLIのメッセージ文言のみagent-progress向けに分ける。
import { computeGap } from './loop-observability-gap.js'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

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

// WHY(issue #806): 素の比較（import.meta.url と、argv[1] の前に file:// を付けた文字列）だと、symlink を含むパスで
//      起動したとき（例: macOS の一時ディレクトリ）に一致せず、main() が走らないまま無出力・exit 0 で終わる。
//      import.meta.url は実体パス、argv[1] は symlink のままだからである。検査にとって無出力・exit 0 は
//      「問題なし」と見分けがつかないので、実体パスへ直してから比べる。
//      この書き方へ戻すと、直接起動の判定を走査する検査（issue #806）が落とす
function isRunAsCli() {
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
