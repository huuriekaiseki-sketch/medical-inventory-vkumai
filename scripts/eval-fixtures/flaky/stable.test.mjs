// 毎回通るテスト（flaky と誤判定しないことの確認用）
import { describe, expect, it } from 'vitest'

describe('fixture: stable', () => {
  it('毎回通る', () => {
    expect(1 + 1).toBe(2)
  })
  it.skip('skip は数えない', () => {
    expect(true).toBe(false)
  })
})
