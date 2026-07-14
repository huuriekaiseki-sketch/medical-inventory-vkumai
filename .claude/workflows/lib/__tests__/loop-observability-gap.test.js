import { describe, it, expect } from 'vitest'
import { computeGap } from '../loop-observability-gap.js'

describe('computeGap', () => {
  it('実際の記録件数が期待件数と一致すればhasGap: false', () => {
    expect(computeGap({ actualCount: 5, expectedCount: 5 })).toEqual({
      actualCount: 5,
      expectedCount: 5,
      hasGap: false,
    })
  })

  it('実際の記録件数が期待件数より少なければhasGap: true（記録漏れ）', () => {
    expect(computeGap({ actualCount: 3, expectedCount: 5 })).toEqual({
      actualCount: 3,
      expectedCount: 5,
      hasGap: true,
    })
  })

  it('実際の記録件数が期待件数より多くてもhasGap: true（重複記録等の異常もズレとして扱う）', () => {
    expect(computeGap({ actualCount: 7, expectedCount: 5 })).toEqual({
      actualCount: 7,
      expectedCount: 5,
      hasGap: true,
    })
  })

  it('期待件数が0で実際も0ならhasGap: false（ログ対象agentTypeを1つも呼ばなかったフロー）', () => {
    expect(computeGap({ actualCount: 0, expectedCount: 0 })).toEqual({
      actualCount: 0,
      expectedCount: 0,
      hasGap: false,
    })
  })
})
