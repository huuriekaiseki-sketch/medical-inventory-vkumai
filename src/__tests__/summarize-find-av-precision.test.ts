import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(process.cwd(), 'scripts', 'summarize-find-av-precision.sh')

describe('summarize-find-av-precision.sh', () => {
  let dir: string
  let logFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'find-av-precision-summary-'))
    logFile = join(dir, 'find-av-precision.jsonl')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function run(args: string[]) {
    return execFileSync(SCRIPT, args, { encoding: 'utf-8' })
  }

  function writeRecords(records: Record<string, unknown>[]) {
    writeFileSync(logFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }

  it('summarizes total counts, per-feature breakdown, and per-lens breakdown', () => {
    writeRecords([
      {
        timestamp: '2026-07-16T00:00:00Z', feature: 'admin-role',
        findCount: 5, verifiedCount: 4, survivedCount: 3, autoSurvivedMinorCount: 1,
        survivalRate: 0.5, byLens: { logic: { verified: 2, survived: 1 } },
      },
      {
        timestamp: '2026-07-16T01:00:00Z', feature: 'admin-role',
        findCount: 2, verifiedCount: 2, survivedCount: 1, autoSurvivedMinorCount: 0,
        survivalRate: 0.5, byLens: { logic: { verified: 1, survived: 0 }, security: { verified: 1, survived: 1 } },
      },
    ])

    const output = run(['--log-file', logFile])

    expect(output).toContain('- 記録された実行回数: 2')
    expect(output).toContain('- 検証件数合計: 6')
    expect(output).toContain('- 生存件数合計（minor自動生存含む）: 4')
    expect(output).toContain('### admin-role')
    expect(output).toContain('- 実行回数: 2')
    expect(output).toContain('- 検証件数: 6')
    expect(output).toContain('- logic: 検証3件 / 生存1件')
    expect(output).toContain('- security: 検証1件 / 生存1件')
  })

  it('does not crash on an empty log file', () => {
    writeFileSync(logFile, '')

    const output = run(['--log-file', logFile])

    expect(output).toContain('- 記録された実行回数: 0')
  })

  it('rejects a missing log file', () => {
    expect(() => run(['--log-file', join(dir, 'missing.jsonl')])).toThrow()
  })

  it('writes the summary to --out instead of stdout when given', () => {
    writeRecords([
      {
        timestamp: '2026-07-16T00:00:00Z', feature: 'admin-role',
        findCount: 1, verifiedCount: 1, survivedCount: 1, autoSurvivedMinorCount: 0,
        survivalRate: 1, byLens: { logic: { verified: 1, survived: 1 } },
      },
    ])
    const outFile = join(dir, 'nested', 'summary.md')

    const stdout = run(['--log-file', logFile, '--out', outFile])

    expect(stdout.trim()).toBe('')
    const written = execFileSync('cat', [outFile], { encoding: 'utf-8' })
    expect(written).toContain('- 記録された実行回数: 1')
  })
})
