import { describe, it, expect } from 'vitest'
import { isValidDateString, jstDayEnd, jstDayStart } from '../jst-date-range'

// WHY: issue #757 の 15。日付境界は「+09:00 を明示しているか」「その日の最後の瞬間まで含むか」
//      「暦に無い日を弾くか」で決まる。実際の Postgres の比較は統合テストではなく、境界の文字列を固定する。

describe('jstDayStart / jstDayEnd', () => {
  it('JST の 0:00 と、その日の最後のマイクロ秒を +09:00 付きで返す', () => {
    expect(jstDayStart('2026-06-27')).toBe('2026-06-27T00:00:00+09:00')
    expect(jstDayEnd('2026-06-27')).toBe('2026-06-27T23:59:59.999999+09:00')
  })

  it('境界を UTC に直すと 15:00Z 〜 翌 14:59:59.999999Z（UTC 固定で扱うと最大 9 時間ずれる）', () => {
    expect(new Date(jstDayStart('2026-06-27')).toISOString()).toBe('2026-06-26T15:00:00.000Z')
    // JS の Date はミリ秒精度なので .999999 は .999 に丸まるが、DB 側は microsecond で受ける
    expect(new Date(jstDayEnd('2026-06-27')).toISOString()).toBe('2026-06-27T14:59:59.999Z')
  })

  it('終了境界は開始境界より後で、翌日の開始より前', () => {
    const end = new Date(jstDayEnd('2026-06-27')).getTime()
    expect(end).toBeGreaterThan(new Date(jstDayStart('2026-06-27')).getTime())
    expect(end).toBeLessThan(new Date(jstDayStart('2026-06-28')).getTime())
  })
})

describe('isValidDateString', () => {
  it.each(['2026-06-27', '2024-02-29', '2026-12-31'])('%s は有効', (v) => {
    expect(isValidDateString(v)).toBe(true)
  })

  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-06-31', '2026-6-1', 'abc', '2026-06-27T00:00:00'])(
    '%s は無効（暦に無い日・形式違い）',
    (v) => {
      expect(isValidDateString(v)).toBe(false)
    },
  )
})
