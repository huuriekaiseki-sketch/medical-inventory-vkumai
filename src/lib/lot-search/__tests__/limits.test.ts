import { describe, expect, it } from 'vitest'
import { LOT_MAX_LENGTH, LOT_MIN_LENGTH, LOT_LENGTH_ERROR_MESSAGE } from '../limits'
import { TEXT_LIMITS } from '@/lib/validation/text-limits'
import { lotSearchQuerySchema } from '@/lib/validation/schemas'

// WHY(issue #814): 画面の上限は設定（aidd.config.json）を直接読めない。読むと設定が丸ごと
//      ブラウザ側の束に入る（2026-09-20 に build して実測。詳細は ../limits.ts）。そこで画面用の
//      定数を 1 つ持ち、**設定と同じ値であること**をここで固定する。
//      このテストが無いと、設定の値を変えたときに画面だけ古い上限で入力を止める（または通す）
describe('ロット検索: 画面の上限が、設定・API の上限と同じ', () => {
  it('画面の上限は aidd.config.json の limits.textLength.lot と同じ', () => {
    expect(LOT_MAX_LENGTH).toBe(TEXT_LIMITS.lot)
  })

  it('画面が通す最大の長さを、API も通す（画面で通って API で 400、を作らない）', () => {
    const atLimit = 'A'.repeat(LOT_MAX_LENGTH)
    expect(lotSearchQuerySchema.safeParse({ lot: atLimit }).success).toBe(true)
  })

  it('画面が止める長さは、API も止める（片方だけ緩い、を作らない）', () => {
    const overLimit = 'A'.repeat(LOT_MAX_LENGTH + 1)
    expect(lotSearchQuerySchema.safeParse({ lot: overLimit }).success).toBe(false)
    expect(lotSearchQuerySchema.safeParse({ lot: '' }).success).toBe(false)
    expect(LOT_MIN_LENGTH).toBe(1)
  })

  it('エラー文言の数字は定数から作る（文言だけ古い数字のまま残らない）', () => {
    expect(LOT_LENGTH_ERROR_MESSAGE).toBe(`${LOT_MIN_LENGTH}〜${LOT_MAX_LENGTH}字で入力してください`)
  })
})
