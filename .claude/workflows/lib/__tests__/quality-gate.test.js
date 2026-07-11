import { describe, it, expect } from 'vitest'
import { shouldBlock } from '../quality-gate.js'

describe('shouldBlock', () => {
  it('全結果がpassならfalse', () => {
    expect(shouldBlock([{ status: 'pass' }, { status: 'pass' }])).toBe(false)
  })

  it('1件でもfailがあればtrue', () => {
    expect(shouldBlock([{ status: 'pass' }, { status: 'fail' }])).toBe(true)
  })

  it('1件でもblockedがあればtrue（着手不能はfailと同様に止める）', () => {
    expect(shouldBlock([{ status: 'pass' }, { status: 'blocked' }])).toBe(true)
  })

  it('nullish要素があってもエラーにならない', () => {
    expect(shouldBlock([null, undefined, { status: 'pass' }])).toBe(false)
  })

  it('空配列ならfalse', () => {
    expect(shouldBlock([])).toBe(false)
  })
})
