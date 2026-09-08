import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getLoanOutstandingCount } from '@/lib/dashboard/loan-outstanding'

// WHY(2026-09-08 に 2 回作り直した): もとは「submitted の数 − returned の数」の件数差、
//      次に埋め込みの anti-join、いまは RPC（loan_outstanding_count）。
//      分割返却を表せるようにしたので、判定が「明細ごとの数量 − 紐付いた返却の合計」になり、
//      PostgREST の埋め込みだけでは書けなくなった。
//      ここで固定するのは **どこへ何を渡したか** と **返ってきた値の扱い**。
//      施設 ID を渡し忘れると全施設を数えることになるので、引数まで見る。

function makeDb(result: { data?: unknown; error?: { message: string } }) {
  const calls: { fn?: string; args?: unknown } = {}
  const db = {
    rpc: vi.fn((fn: string, args: unknown) => {
      calls.fn = fn
      calls.args = args
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null })
    }),
  } as unknown as SupabaseClient
  return { db, calls }
}

describe('getLoanOutstandingCount の呼び方', () => {
  it('loan_outstanding_count に施設 ID を渡す', async () => {
    const { db, calls } = makeDb({ data: 3 })
    await getLoanOutstandingCount(db, 'f-9')
    expect(calls.fn).toBe('loan_outstanding_count')
    expect(calls.args).toEqual({ p_facility_id: 'f-9' })
  })
})

describe('getLoanOutstandingCount が返す値', () => {
  it('DB が数えた件数をそのまま返す', async () => {
    const { db } = makeDb({ data: 4 })
    await expect(getLoanOutstandingCount(db, 'f-1')).resolves.toBe(4)
  })

  it('0 件なら 0', async () => {
    const { db } = makeDb({ data: 0 })
    await expect(getLoanOutstandingCount(db, 'f-1')).resolves.toBe(0)
  })

  it('数値でない値（null 等）は 0 として扱う', async () => {
    // WHY: RPC が null を返すのは「行が無い」ではなく「数えられなかった」なので、
    //      画面に NaN を出さない。0 に倒して表示は「未返却なし」にする
    const { db } = makeDb({ data: null })
    await expect(getLoanOutstandingCount(db, 'f-1')).resolves.toBe(0)
  })

  it('エラー時は例外を投げる', async () => {
    const { db } = makeDb({ error: { message: 'DB error' } })
    await expect(getLoanOutstandingCount(db, 'f-5')).rejects.toThrow('DB error')
  })
})
