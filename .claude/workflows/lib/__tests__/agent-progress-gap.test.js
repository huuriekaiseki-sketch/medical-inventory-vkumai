import { describe, it, expect } from 'vitest'
import { computeGap } from '../agent-progress-gap.js'

describe('computeGap（agent-progress版、loop-observability-gap.jsのロジックを再利用）', () => {
  it('実際の記録件数が期待件数と一致すればhasGap: false', () => {
    expect(computeGap({ actualCount: 4, expectedCount: 4 })).toEqual({
      actualCount: 4,
      expectedCount: 4,
      hasGap: false,
    })
  })

  it('実際の記録件数が期待件数より少なければhasGap: true（記録漏れ）', () => {
    expect(computeGap({ actualCount: 2, expectedCount: 4 })).toEqual({
      actualCount: 2,
      expectedCount: 4,
      hasGap: true,
    })
  })
})
