import { describe, it, expect } from 'vitest'
import { classifyReviewRound } from '../review-retry.js'

const DIMENSIONS = [
  { key: 'correctness', label: '正しさ' },
  { key: 'coverage',    label: 'カバレッジ' },
]

describe('classifyReviewRound', () => {
  it('全観点passならdone=true, blocked=false', () => {
    const result = classifyReviewRound(
      [{ status: 'pass', detail: '指摘なし' }, { status: 'pass', detail: '指摘なし' }],
      DIMENSIONS, 1, 3
    )
    expect(result).toEqual({ done: true, blocked: false, failingDimensions: [] })
  })

  it('blockedのみ(fail無し)ならdone=true, blocked=false（レビュー自体ができなかっただけで差し戻し対象ではない）', () => {
    const result = classifyReviewRound(
      [{ status: 'blocked', detail: '対象が見つからない' }, { status: 'pass', detail: '指摘なし' }],
      DIMENSIONS, 1, 3
    )
    expect(result.done).toBe(true)
    expect(result.blocked).toBe(false)
  })

  it('failが1件でもあり、上限内ならdone=falseで差し戻し対象を返す', () => {
    const result = classifyReviewRound(
      [{ status: 'fail', detail: 'バグあり' }, { status: 'pass', detail: '指摘なし' }],
      DIMENSIONS, 1, 3
    )
    expect(result.done).toBe(false)
    expect(result.blocked).toBe(false)
    expect(result.failingDimensions).toHaveLength(1)
    expect(result.failingDimensions[0].dim.key).toBe('correctness')
  })

  it('わざと毎回failするダミーレビューは、maxRetries回の差し戻し後(attempt=maxRetries+1)にblockedで停止する', () => {
    const maxRetries = 3
    const dummyFailResults = [{ status: 'fail', detail: '直らない指摘' }, { status: 'pass', detail: '指摘なし' }]

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const result = classifyReviewRound(dummyFailResults, DIMENSIONS, attempt, maxRetries)
      expect(result.done).toBe(false)
      expect(result.blocked).toBe(false)
    }

    const finalResult = classifyReviewRound(dummyFailResults, DIMENSIONS, maxRetries + 1, maxRetries)
    expect(finalResult.done).toBe(true)
    expect(finalResult.blocked).toBe(true)
    expect(finalResult.failingDimensions).toHaveLength(1)
  })

  it('failだがfindings全件がminorなら差し戻し対象外でdone=true, blocked=false（UIの軽微な指摘だけで修正ループを回さない）', () => {
    const result = classifyReviewRound(
      [
        { status: 'fail', findings: [{ severity: 'minor', description: 'ボタンの余白が気になる' }] },
        { status: 'pass', detail: '指摘なし' },
      ],
      DIMENSIONS, 1, 3
    )
    expect(result.done).toBe(true)
    expect(result.blocked).toBe(false)
    expect(result.failingDimensions).toHaveLength(0)
  })

  it('failでfindingsにimportant/criticalが混ざれば従来通り差し戻し対象になる', () => {
    const result = classifyReviewRound(
      [
        { status: 'fail', findings: [{ severity: 'critical', description: 'RLSポリシー漏れ' }] },
        { status: 'pass', detail: '指摘なし' },
      ],
      DIMENSIONS, 1, 3
    )
    expect(result.done).toBe(false)
    expect(result.failingDimensions).toHaveLength(1)
  })

  it('failでfindingsを省略した場合は従来通り差し戻し対象になる（deny-by-default）', () => {
    const result = classifyReviewRound(
      [{ status: 'fail', detail: '指摘あり（findings無し）' }, { status: 'pass', detail: '指摘なし' }],
      DIMENSIONS, 1, 3
    )
    expect(result.done).toBe(false)
    expect(result.failingDimensions).toHaveLength(1)
  })
})
