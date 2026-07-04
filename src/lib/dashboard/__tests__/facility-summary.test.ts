import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getFacilityOrderSummary } from '@/lib/dashboard/facility-summary'

function makeDb(countsByTable: Record<string, number>, latestByTable: Record<string, string | null>) {
  return {
    from: vi.fn((table: string) => ({
      select: vi.fn((_cols: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) {
          return {
            eq: vi.fn().mockResolvedValue({ count: countsByTable[table] ?? 0, error: null }),
          }
        }
        return {
          eq: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue({
                data: latestByTable[table] ? [{ created_at: latestByTable[table] }] : [],
                error: null,
              }),
            })),
          })),
        }
      }),
    })),
  } as unknown as SupabaseClient
}

describe('getFacilityOrderSummary', () => {
  it('発注が1件もない施設は全てcount:0, latestAt:nullを返す', async () => {
    const db = makeDb({}, {})
    const result = await getFacilityOrderSummary(db, 'f-1')
    expect(result).toEqual({
      facilityId: 'f-1',
      caseOrderCount: 0,
      caseOrderLatestAt: null,
      consumableOrderCount: 0,
      consumableOrderLatestAt: null,
      loanOrderCount: 0,
      loanOrderLatestAt: null,
    })
  })

  it('3種類すべて存在する施設は各々の件数・最新日時を返す', async () => {
    const db = makeDb(
      { case_orders: 2, consumable_orders: 3, loan_orders: 1 },
      {
        case_orders: '2026-07-01T00:00:00Z',
        consumable_orders: '2026-07-02T00:00:00Z',
        loan_orders: '2026-07-03T00:00:00Z',
      }
    )
    const result = await getFacilityOrderSummary(db, 'f-2')
    expect(result).toEqual({
      facilityId: 'f-2',
      caseOrderCount: 2,
      caseOrderLatestAt: '2026-07-01T00:00:00Z',
      consumableOrderCount: 3,
      consumableOrderLatestAt: '2026-07-02T00:00:00Z',
      loanOrderCount: 1,
      loanOrderLatestAt: '2026-07-03T00:00:00Z',
    })
  })

  it('count取得時のエラーは例外を投げる', async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ count: null, error: { message: 'DB error' } }),
        })),
      })),
    } as unknown as SupabaseClient

    await expect(getFacilityOrderSummary(db, 'f-3')).rejects.toThrow('DB error')
  })
})
