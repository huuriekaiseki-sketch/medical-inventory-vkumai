import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TestCase, TestResult } from '@playwright/test/reporter'

const execFileSyncMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    default: { ...actual, execFileSync: execFileSyncMock },
    execFileSync: execFileSyncMock,
  }
})

const { default: LoopObservabilityReporter } = await import(
  '../../scripts/playwright-loop-observability-reporter'
)

function makeTestCase(titlePath: string[]): TestCase {
  return { titlePath: () => titlePath } as unknown as TestCase
}

function makeResult(overrides: Partial<TestResult> = {}): TestResult {
  return { status: 'passed', ...overrides } as TestResult
}

describe('LoopObservabilityReporter', () => {
  const ORIGINAL_CI = process.env.CI

  beforeEach(() => {
    execFileSyncMock.mockReset()
    delete process.env.LOOP_OBSERVABILITY_AGENT
    delete process.env.LOOP_OBSERVABILITY_FEATURE
    delete process.env.LOOP_OBSERVABILITY_ATTEMPT
    delete process.env.LOOP_OBSERVABILITY_MODEL
    delete process.env.CI
  })

  afterEach(() => {
    if (ORIGINAL_CI === undefined) delete process.env.CI
    else process.env.CI = ORIGINAL_CI
  })

  it('defaults --agent to e2e-runner so it is never mistaken for a human judgment', () => {
    const reporter = new LoopObservabilityReporter()
    reporter.onTestEnd(
      makeTestCase(['e2e/smoke.spec.ts', 'ページスモークテスト', 'デバイス一覧が開いてクラッシュしない']),
      makeResult({ status: 'passed' })
    )

    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    const args = execFileSyncMock.mock.calls[0][1] as string[]
    expect(args).toEqual(
      expect.arrayContaining([
        '--loop', 'developer',
        '--agent', 'e2e-runner',
        '--feature', 'e2e',
        '--attempt', '1',
        '--model', 'n/a',
        '--result', 'pass',
        '--reason', 'ローカル手動実行: テスト成功',
        '--scenario', 'ページスモークテスト > デバイス一覧が開いてクラッシュしない',
      ])
    )
  })

  it('prefixes the reason with CI実行 when running under CI', () => {
    process.env.CI = 'true'
    const reporter = new LoopObservabilityReporter()
    reporter.onTestEnd(makeTestCase(['e2e/smoke.spec.ts', 'test']), makeResult({ status: 'passed' }))

    const args = execFileSyncMock.mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining(['--reason', 'CI実行: テスト成功']))
  })

  it('logs a failed test with result=fail and a truncated error reason', () => {
    const reporter = new LoopObservabilityReporter()
    reporter.onTestEnd(
      makeTestCase(['e2e/smoke.spec.ts', '未認証でアクセスすると /login にリダイレクトされる']),
      makeResult({ status: 'failed', error: { message: 'x'.repeat(300) } })
    )

    const args = execFileSyncMock.mock.calls[0][1] as string[]
    expect(args).toContain('fail')
    const reasonIndex = args.indexOf('--reason')
    expect(args[reasonIndex + 1]).toHaveLength(200)
    expect(args[reasonIndex + 1].startsWith('ローカル手動実行: ')).toBe(true)
  })

  it('reads agent/feature/attempt/model overrides from environment variables', () => {
    process.env.LOOP_OBSERVABILITY_AGENT = 'implementer'
    process.env.LOOP_OBSERVABILITY_FEATURE = 'loop-observability'
    process.env.LOOP_OBSERVABILITY_ATTEMPT = '2'
    process.env.LOOP_OBSERVABILITY_MODEL = 'sonnet'

    const reporter = new LoopObservabilityReporter()
    reporter.onTestEnd(makeTestCase(['e2e/smoke.spec.ts', 'test']), makeResult())

    const args = execFileSyncMock.mock.calls[0][1] as string[]
    expect(args).toEqual(
      expect.arrayContaining([
        '--agent', 'implementer',
        '--feature', 'loop-observability',
        '--attempt', '2',
        '--model', 'sonnet',
      ])
    )
  })
})
