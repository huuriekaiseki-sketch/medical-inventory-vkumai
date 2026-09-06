import { describe, it, expect } from 'vitest'
import { formatJstDate, formatJstDateTime, formatJstDateTimeShort } from '../format-date'

// WHY: issue #757 の 15。境界は「UTC ではまだ前日、JST では翌日」の瞬間。
//      vitest は TZ=UTC で走る（vitest.config.ts。Vercel と同じ条件）ので、
//      環境のタイムゾーンに引きずられる実装ならここが落ちる。

const JST_MIDNIGHT_UTC = '2026-06-26T15:00:00Z' // = 2026-06-27 00:00 JST
const JST_LAST_SECOND_UTC = '2026-06-27T14:59:59Z' // = 2026-06-27 23:59:59 JST

describe('formatJstDate', () => {
  it('UTC の 15:00 は JST では翌日の 0:00 なので翌日の日付になる', () => {
    expect(formatJstDate(JST_MIDNIGHT_UTC)).toBe('2026/6/27')
  })

  it('JST の 23:59:59 はまだ同じ日', () => {
    expect(formatJstDate(JST_LAST_SECOND_UTC)).toBe('2026/6/27')
  })

  it('1 秒後は翌日', () => {
    expect(formatJstDate('2026-06-27T15:00:00Z')).toBe('2026/6/28')
  })

  it('Date も受ける', () => {
    expect(formatJstDate(new Date(JST_MIDNIGHT_UTC))).toBe('2026/6/27')
  })

  it('環境のタイムゾーンを変えても結果が変わらない', () => {
    const before = process.env.TZ
    try {
      for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
        process.env.TZ = tz
        expect(formatJstDate(JST_MIDNIGHT_UTC)).toBe('2026/6/27')
      }
    } finally {
      process.env.TZ = before
    }
  })
})

describe('formatJstDateTime / formatJstDateTimeShort', () => {
  it('時刻も JST で出す', () => {
    expect(formatJstDateTime(JST_MIDNIGHT_UTC)).toBe('2026/6/27 0:00:00')
    expect(formatJstDateTimeShort(JST_MIDNIGHT_UTC)).toBe('2026/06/27 00:00')
  })
})
