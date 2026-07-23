import { describe, it, expect } from 'vitest'
import { buildRetryHistorySection } from '../review-retry-history.js'

describe('buildRetryHistorySection', () => {
  it('履歴が空なら空文字列を返す(1回目のretryではセクションを追加しない)', () => {
    expect(buildRetryHistorySection([])).toBe('')
    expect(buildRetryHistorySection(undefined)).toBe('')
    expect(buildRetryHistorySection(null)).toBe('')
  })

  it('1件の履歴からattempt番号・指摘・修正報告を含むセクションを生成する', () => {
    const section = buildRetryHistorySection([
      { attempt: 1, findings: '## 正しさ\n境界条件のバグ', detail: '境界条件を修正しました' },
    ])
    expect(section).toContain('## 前回までの修正履歴')
    expect(section).toContain('### attempt 1')
    expect(section).toContain('境界条件のバグ')
    expect(section).toContain('境界条件を修正しました')
  })

  it('修正報告(detail)が無い場合は「(報告なし)」と表示する', () => {
    const section = buildRetryHistorySection([{ attempt: 1, findings: '指摘A', detail: undefined }])
    expect(section).toContain('(報告なし)')
  })

  it('プロンプト肥大対策として直近2件のみを含め、それより古い履歴は含めない', () => {
    const section = buildRetryHistorySection([
      { attempt: 1, findings: '指摘1', detail: '修正1' },
      { attempt: 2, findings: '指摘2', detail: '修正2' },
      { attempt: 3, findings: '指摘3', detail: '修正3' },
    ])
    expect(section).not.toContain('attempt 1')
    expect(section).toContain('attempt 2')
    expect(section).toContain('attempt 3')
  })

  it('複数attemptを古い順に並べる', () => {
    const section = buildRetryHistorySection([
      { attempt: 1, findings: '指摘1', detail: '修正1' },
      { attempt: 2, findings: '指摘2', detail: '修正2' },
    ])
    expect(section.indexOf('attempt 1')).toBeLessThan(section.indexOf('attempt 2'))
  })
})
