import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getLoanOutstandingCount } from '@/lib/dashboard/loan-outstanding'

function makeDb(submittedCount: number | null, returnedCount: number | null, errorTable?: string) {
  return {
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue(
            errorTable === table
              ? { count: null, error: { message: 'DB error' } }
              : { count: table === 'loan_orders' ? submittedCount : returnedCount, error: null }
          ),
        })),
      })),
    })),
  } as unknown as SupabaseClient
}

describe('getLoanOutstandingCount', () => {
  it('提出0件の場合は0を返す', async () => {
    const db = makeDb(0, 0)
    const result = await getLoanOutstandingCount(db, 'f-1')
    expect(result).toBe(0)
  })

  it('提出 > 返却の場合は差分を返す', async () => {
    const db = makeDb(5, 2)
    const result = await getLoanOutstandingCount(db, 'f-2')
    expect(result).toBe(3)
  })

  it('提出 = 返却の場合は0を返す', async () => {
    const db = makeDb(3, 3)
    const result = await getLoanOutstandingCount(db, 'f-3')
    expect(result).toBe(0)
  })

  it('返却 > 提出の場合は0に丸める', async () => {
    const db = makeDb(1, 4)
    const result = await getLoanOutstandingCount(db, 'f-4')
    expect(result).toBe(0)
  })

  it('エラー時は例外を投げる', async () => {
    const db = makeDb(null, null, 'loan_orders')
    await expect(getLoanOutstandingCount(db, 'f-5')).rejects.toThrow('DB error')
  })
})
