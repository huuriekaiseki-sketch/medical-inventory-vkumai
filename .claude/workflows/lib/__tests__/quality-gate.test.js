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

  it('nullish要素があればtrue（deny-by-default: passと確認できないものは止める）', () => {
    expect(shouldBlock([null, undefined, { status: 'pass' }])).toBe(true)
  })

  it('未知のstatus値があればtrue（deny-by-default）', () => {
    expect(shouldBlock([{ status: 'weird' }, { status: 'pass' }])).toBe(true)
  })

  it('全結果がpassの場合のみfalse', () => {
    expect(shouldBlock([{ status: 'pass' }, { status: 'pass' }])).toBe(false)
  })

  it('空配列ならfalse（判定対象自体が無い）', () => {
    expect(shouldBlock([])).toBe(false)
  })
})
