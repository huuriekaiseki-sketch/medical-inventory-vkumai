import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
// 拡張子付き import: npx tsx ではなく Node 標準の型除去（--experimental-strip-types）で直接実行するため
// （Node の ESM 解決は拡張子を補完しない。tsconfig の allowImportingTsExtensions で型検査も通す）
import { journalAdapter, type CanonicalEvent } from './canonical-event.ts'

// WHY: issue #642。journalAdapterが読むwf_*ディレクトリ(~/.claude/projects/配下)は
// transcript cleanupで消えるため(実測: 2026-08-22時点で3ディレクトリしか残存せず)、
// 月次集計の窓を保つには消える前にlogs/配下の永続JSONLへ収穫しておく必要がある。
//
// 重複排除キーはeventIdではなくsource+agentIdを使う。journalAdapterのeventIdは
// 全wf_*横断の出現順連番(lineIndex)を含むため、古いwf_*が消えると同一イベントの
// eventIdが収穫のたびに変わり、eventId基準では重複排除が壊れる。agentIdは
// エージェント実行ごとに一意で、ディレクトリの増減に影響されない。

export function harvestKey(event: CanonicalEvent): string {
  return `${event.source}:${event.agentId}`
}

export function loadHarvestedEvents(outputFile: string): CanonicalEvent[] {
  let content: string
  try {
    content = readFileSync(outputFile, 'utf-8')
  } catch {
    return []
  }
  const events: CanonicalEvent[] = []
  for (const raw of content.split('\n').filter(Boolean)) {
    try {
      events.push(JSON.parse(raw) as CanonicalEvent)
    } catch {
      // 壊れた行(部分書き込み等)は無言でスキップし、収穫全体は止めない
    }
  }
  return events
}

export interface HarvestResult {
  appended: number
  skipped: number
}

export function harvestJournalEvents(
  projectDir: string,
  outputFile: string,
  loadEvents: (dir: string) => CanonicalEvent[] = (dir) => journalAdapter(dir).load(),
): HarvestResult {
  const seen = new Set(loadHarvestedEvents(outputFile).map(harvestKey))
  let appended = 0
  let skipped = 0
  const lines: string[] = []
  for (const event of loadEvents(projectDir)) {
    if (event.agentId === null) {
      skipped += 1
      continue
    }
    const key = harvestKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(JSON.stringify(event))
    appended += 1
  }
  if (lines.length > 0) {
    mkdirSync(dirname(outputFile), { recursive: true })
    appendFileSync(outputFile, lines.join('\n') + '\n')
  }
  return { appended, skipped }
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
  const outputFile = getArg('--output', 'logs/journal-harvest.jsonl')

  const result = harvestJournalEvents(projectDir, outputFile)
  console.log(`journal harvest: ${result.appended}件追記, ${result.skipped}件スキップ → ${outputFile}`)
}

// WHY: 単純な`file://${argv[1]}`比較だと、argv[1]がsymlink経由のパス
// (例: macOSの/var/folders→/private/var/folders)のときimport.meta.url(実パス)と
// 一致せずmain()が無言でスキップされる。realpathで正規化する。
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
