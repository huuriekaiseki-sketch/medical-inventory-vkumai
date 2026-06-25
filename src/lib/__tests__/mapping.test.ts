import { describe, it, expect } from 'vitest'
import { asString, asOptionalString, asNullableString, asNumber, asNullableNumber } from '../mapping'

describe('asString', () => {
  it('文字列はそのまま返す', () => {
    expect(asString('hello')).toBe('hello')
  })
  it('非文字列は空文字を返す', () => {
    expect(asString(123)).toBe('')
    expect(asString(null)).toBe('')
    expect(asString(undefined)).toBe('')
    expect(asString({})).toBe('')
  })
})

describe('asOptionalString', () => {
  it('文字列はそのまま返す', () => {
    expect(asOptionalString('x')).toBe('x')
  })
  it('null/undefined/非文字列は undefined を返す', () => {
    expect(asOptionalString(null)).toBeUndefined()
    expect(asOptionalString(undefined)).toBeUndefined()
    expect(asOptionalString(5)).toBeUndefined()
  })
})

describe('asNullableString', () => {
  it('文字列はそのまま返す', () => {
    expect(asNullableString('x')).toBe('x')
  })
  it('null/undefined/非文字列は null を返す', () => {
    expect(asNullableString(null)).toBeNull()
    expect(asNullableString(undefined)).toBeNull()
    expect(asNullableString(5)).toBeNull()
  })
})

describe('asNumber', () => {
  it('数値はそのまま返す', () => {
    expect(asNumber(42)).toBe(42)
  })
  it('数値文字列は変換する', () => {
    expect(asNumber('42')).toBe(42)
  })
  it('NaN になる値は 0 を返す', () => {
    expect(asNumber('abc')).toBe(0)
    expect(asNumber(null)).toBe(0)
    expect(asNumber(undefined)).toBe(0)
    expect(asNumber({})).toBe(0)
  })
})

describe('asNullableNumber', () => {
  it('数値はそのまま返す', () => {
    expect(asNullableNumber(42)).toBe(42)
    expect(asNullableNumber(0)).toBe(0)
  })
  it('null/undefined は null を返す', () => {
    expect(asNullableNumber(null)).toBeNull()
    expect(asNullableNumber(undefined)).toBeNull()
  })
  it('NaN になる値は null を返す', () => {
    expect(asNullableNumber('abc')).toBeNull()
  })
})
