import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getLoanOutstandingCount } from '@/lib/dashboard/loan-outstanding'

// WHY(2026-09-08 に作り直した): 以前は「submitted の数 − returned の数」で近似していたので、
//      テストも「差分」「0 に丸める」を見ていた。判定を紐付けベース（submitted かつ紐付いた
//      返却が無い発注）へ変えたので、見るものも「どう問い合わせたか」と「返ってきた数」に変わる。
//      **問い合わせの形を固定する**のは、埋め込みの anti-join（loan_returns=is.null）を
//      落とすと件数が静かに増える（全 submitted が未返却になる）ため。

type Calls = {
  table?: string
  select?: string
  options?: unknown
  eqs: Array<[string, unknown]>
  is?: [string, unknown]
}

function makeDb(count: number | null, errorMessage?: string) {
  const calls: Calls = { eqs: [] }
  const result = errorMessage
    ? { count: null, error: { message: errorMessage } }
    : { count, error: null }

  const builder = {
    eq: vi.fn((col: string, val: unknown) => {
      calls.eqs.push([col, val])
      return builder
    }),
    is: vi.fn((col: string, val: unknown) => {
      calls.is = [col, val]
      return Promise.resolve(result)
    }),
  }

  const db = {
    from: vi.fn((table: string) => {
      calls.table = table
      return {
        select: vi.fn((sel: string, options: unknown) => {
          calls.select = sel
          calls.options = options
          return builder
        }),
      }
    }),
  } as unknown as SupabaseClient

  return { db, calls }
}

describe('getLoanOutstandingCount の問い合わせの形', () => {
  it('loan_orders を、返却を left で埋め込んで head だけで数える', async () => {
    const { db, calls } = makeDb(3)
    await getLoanOutstandingCount(db, 'f-1')
    expect(calls.table).toBe('loan_orders')
    expect(calls.select).toContain('loan_returns!left(id)')
    expect(calls.options).toEqual({ count: 'exact', head: true })
  })

  it('施設と submitted で絞る', async () => {
    const { db, calls } = makeDb(3)
    await getLoanOutstandingCount(db, 'f-9')
    expect(calls.eqs).toEqual([
      ['facility_id', 'f-9'],
      ['status', 'submitted'],
    ])
  })

  it('紐付いた返却が無いものだけを数える（この 1 行が消えると件数が水増しされる）', async () => {
    const { db, calls } = makeDb(3)
    await getLoanOutstandingCount(db, 'f-1')
    expect(calls.is).toEqual(['loan_returns', null])
  })
})

describe('getLoanOutstandingCount が返す値', () => {
  it('DB が数えた件数をそのまま返す', async () => {
    const { db } = makeDb(4)
    await expect(getLoanOutstandingCount(db, 'f-1')).resolves.toBe(4)
  })

  it('0 件なら 0', async () => {
    const { db } = makeDb(0)
    await expect(getLoanOutstandingCount(db, 'f-1')).resolves.toBe(0)
  })

  it('count が null（数えられなかった）なら 0 として扱う', async () => {
    const { db } = makeDb(null)
    await expect(getLoanOutstandingCount(db, 'f-1')).resolves.toBe(0)
  })

  it('エラー時は例外を投げる', async () => {
    const { db } = makeDb(null, 'DB error')
    await expect(getLoanOutstandingCount(db, 'f-5')).rejects.toThrow('DB error')
  })
})
