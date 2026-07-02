import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(process.cwd(), 'scripts', 'summarize-loop-observability.sh')

describe('summarize-loop-observability.sh', () => {
  let dir: string
  let logFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-observability-summary-'))
    logFile = join(dir, 'loop-observability.jsonl')
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

  it('summarizes total counts, per-feature breakdown, and failures', () => {
    writeRecords([
      {
        timestamp: '2026-07-02T01:00:00Z', loop: 'agentic', agent: 'implementer',
        feature: 'admin-role', attempt: 1, model: 'sonnet', tokens: null, costUsd: null,
        intent: 'add role field', scenario: 'unit test', result: 'fail', reason: '型エラー',
      },
      {
        timestamp: '2026-07-02T01:05:00Z', loop: 'agentic', agent: 'implementer',
        feature: 'admin-role', attempt: 2, model: 'sonnet', tokens: null, costUsd: null,
        intent: 'add role field', scenario: 'unit test', result: 'pass', reason: '修正して成功',
      },
      {
        timestamp: '2026-07-02T01:10:00Z', loop: 'developer', agent: 'reviewer',
        feature: 'admin-role', attempt: 1, model: 'sonnet', tokens: null, costUsd: null,
        intent: 'review', scenario: 'quality review', result: 'pass', reason: '指摘0件',
      },
    ])

    const output = run(['--log-file', logFile])

    expect(output).toContain('- 総レコード数: 3')
    expect(output).toContain('- loop別: agentic=2, developer=1, external=0')
    expect(output).toContain('- 結果: pass=2, fail=1, other=0')
    expect(output).toContain('### admin-role')
    expect(output).toContain('- 試行回数: 3')
    expect(output).toContain('- 成功: 2/3')
    expect(output).toContain('- agent: implementer, reviewer')
    expect(output).toContain(
      '- [2026-07-02T01:00:00Z] loop=agentic agent=implementer feature=admin-role attempt=1 scenario="unit test" reason="型エラー"'
    )
  })

  it('reports no failures when every record passed', () => {
    writeRecords([
      {
        timestamp: '2026-07-02T01:00:00Z', loop: 'developer', agent: 'e2e-runner',
        feature: 'e2e', attempt: 1, model: 'n/a', tokens: null, costUsd: null,
        intent: 'Playwright e2eテスト実行', scenario: 'smoke test', result: 'pass',
        reason: 'ローカル手動実行: テスト成功',
      },
    ])

    const output = run(['--log-file', logFile])

    expect(output).toContain('## 失敗一覧\n- なし')
  })

  it('does not crash on an empty log file', () => {
    writeFileSync(logFile, '')

    const output = run(['--log-file', logFile])

    expect(output).toContain('- 総レコード数: 0')
    expect(output).toContain('## 失敗一覧\n- なし')
  })

  it('rejects a missing log file', () => {
    expect(() => run(['--log-file', join(dir, 'missing.jsonl')])).toThrow()
  })

  it('writes the summary to --out instead of stdout when given', () => {
    writeRecords([
      {
        timestamp: '2026-07-02T01:00:00Z', loop: 'external', agent: 'human',
        feature: 'admin-role', attempt: 1, model: null, tokens: null, costUsd: null,
        intent: 'manual check', scenario: 'smoke', result: 'pass', reason: '確認OK',
      },
    ])
    const outFile = join(dir, 'nested', 'summary.md')

    const stdout = run(['--log-file', logFile, '--out', outFile])

    expect(stdout.trim()).toBe('')
    const written = execFileSync('cat', [outFile], { encoding: 'utf-8' })
    expect(written).toContain('- loop別: agentic=0, developer=0, external=1')
  })
})
