import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(process.cwd(), 'scripts', 'log-loop-observability.sh')

describe('log-loop-observability.sh', () => {
  let dir: string
  let logFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-observability-'))
    logFile = join(dir, 'loop-observability.jsonl')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function run(args: string[]) {
    execFileSync(SCRIPT, args, { encoding: 'utf-8' })
  }

  const baseArgs = (overrides: Record<string, string> = {}) => {
    const defaults: Record<string, string> = {
      '--agent': 'implementer',
      '--feature': 'admin-role',
      '--attempt': '1',
      '--model': 'sonnet',
      '--intent': 'add role field',
      '--scenario': 'unit test for role update',
      '--result': 'pass',
      '--reason': 'test passed on first try',
      '--log-file': logFile,
    }
    const merged = { ...defaults, ...overrides }
    return Object.entries(merged).flatMap(([k, v]) => [k, v])
  }

  it('appends a JSON line with the expected fields', () => {
    run(baseArgs())

    const lines = readFileSync(logFile, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)

    const record = JSON.parse(lines[0])
    expect(record).toMatchObject({
      loop: 'agentic',
      agent: 'implementer',
      feature: 'admin-role',
      attempt: 1,
      model: 'sonnet',
      tokens: null,
      costUsd: null,
      intent: 'add role field',
      scenario: 'unit test for role update',
      result: 'pass',
      reason: 'test passed on first try',
    })
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('appends multiple attempts as separate lines', () => {
    run(baseArgs({ '--attempt': '1', '--result': 'fail' }))
    run(baseArgs({ '--attempt': '2', '--result': 'pass' }))

    const lines = readFileSync(logFile, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).attempt).toBe(1)
    expect(JSON.parse(lines[0]).result).toBe('fail')
    expect(JSON.parse(lines[1]).attempt).toBe(2)
    expect(JSON.parse(lines[1]).result).toBe('pass')
  })

  it('rejects a non-integer --attempt', () => {
    expect(() => run(baseArgs({ '--attempt': 'abc' }))).toThrow()
  })

  it('rejects a missing required argument', () => {
    const args = baseArgs()
    const idx = args.indexOf('--reason')
    args.splice(idx, 2)
    expect(() => run(args)).toThrow()
  })

  it('creates the log directory if missing', () => {
    const nestedLogFile = join(dir, 'nested', 'loop-observability.jsonl')
    run(baseArgs({ '--log-file': nestedLogFile }))
    expect(readFileSync(nestedLogFile, 'utf-8').trim().split('\n')).toHaveLength(1)
  })

  it('rejects unrecognized flags to prevent accidental tokens/costUsd injection', () => {
    // Regression test: --tokens flag does not exist and must be rejected
    const argsWithTokens = [...baseArgs(), '--tokens', '5']
    expect(() => run(argsWithTokens)).toThrow()

    // Similarly, --costUsd flag does not exist and must be rejected
    const argsWithCostUsd = [...baseArgs(), '--costUsd', '1.23']
    expect(() => run(argsWithCostUsd)).toThrow()
  })
})
