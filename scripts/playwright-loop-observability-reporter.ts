import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const SCRIPT_PATH = path.join(__dirname, 'log-loop-observability.sh')
const MAX_REASON_LENGTH = 200

export default class LoopObservabilityReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult): void {
    const passed = result.status === 'passed'
    const executionContext = process.env.CI ? 'CI実行' : 'ローカル手動実行'
    const reason = (
      passed
        ? `${executionContext}: テスト成功`
        : `${executionContext}: ${(result.error?.message ?? 'テスト失敗').replace(/\s+/g, ' ')}`
    ).slice(0, MAX_REASON_LENGTH)

    execFileSync(SCRIPT_PATH, [
      '--loop', 'developer',
      '--agent', process.env.LOOP_OBSERVABILITY_AGENT ?? 'e2e-runner',
      '--feature', process.env.LOOP_OBSERVABILITY_FEATURE ?? 'e2e',
      '--attempt', process.env.LOOP_OBSERVABILITY_ATTEMPT ?? '1',
      '--model', process.env.LOOP_OBSERVABILITY_MODEL ?? 'n/a',
      '--intent', 'Playwright e2eテスト実行',
      '--scenario', test.titlePath().slice(1).join(' > '),
      '--result', passed ? 'pass' : 'fail',
      '--reason', reason,
    ])
  }
}
