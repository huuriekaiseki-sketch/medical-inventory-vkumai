import { describe, it, expect } from 'vitest'
import { jstDayStart, jstDayEnd, isValidDateString } from '@/lib/jst-date-range'

// WHY: 「YYYY-MM-DD を JST の日境界として created_at(UTC) の gte/lte に変換する」ロジックが
//      case-orders/consumable-orders/loan-orders/loan-returns/ordersの各repositoryに
//      文字列テンプレートとして重複実装されていた（issue #20 レビュー指摘: 重複・過剰実装）。
//      1箇所にまとめ、境界の仕様（+09:00固定）を変更する際の修正漏れを防ぐ
describe('jstDayStart', () => {
  it('YYYY-MM-DDをJSTの0:00境界の文字列に変換する', () => {
    expect(jstDayStart('2026-07-13')).toBe('2026-07-13T00:00:00+09:00')
  })
})

describe('jstDayEnd', () => {
  it('YYYY-MM-DDをJSTの23:59:59境界の文字列に変換する', () => {
    expect(jstDayEnd('2026-07-13')).toBe('2026-07-13T23:59:59+09:00')
  })
})

describe('isValidDateString', () => {
  it('正しいYYYY-MM-DD形式はtrueを返す', () => {
    expect(isValidDateString('2026-07-13')).toBe(true)
  })

  it('形式が違う値はfalseを返す', () => {
    expect(isValidDateString('abc')).toBe(false)
    expect(isValidDateString('2026/07/13')).toBe(false)
    expect(isValidDateString('2026-7-13')).toBe(false)
    expect(isValidDateString('')).toBe(false)
  })

  it('形式は正しいが実在しない暦日はfalseを返す', () => {
    expect(isValidDateString('2026-13-01')).toBe(false)
    expect(isValidDateString('2026-02-30')).toBe(false)
  })

  it('うるう年の2/29はtrueを返す', () => {
    expect(isValidDateString('2024-02-29')).toBe(true)
  })
})
