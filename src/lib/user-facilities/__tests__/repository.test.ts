import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { listUserFacilities } from '@/lib/user-facilities/repository'

describe('listUserFacilities', () => {
  it('所属施設が複数件（adminロール混在）の場合、facilityId/facilityName/roleを返す', async () => {
    const rows = [
      { facility_id: 'f-1', role: 'admin', facilities: { name: '病院A' } },
      { facility_id: 'f-2', role: 'staff', facilities: { name: '病院B' } },
    ]
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: rows, error: null }),
        })),
      })),
    } as unknown as SupabaseClient

    const result = await listUserFacilities(db, 'u-1')

    expect(result).toEqual([
      { facilityId: 'f-1', facilityName: '病院A', role: 'admin' },
      { facilityId: 'f-2', facilityName: '病院B', role: 'staff' },
    ])
  })

  it('所属施設が0件の場合、空配列を返す', async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: [], error: null }),
        })),
      })),
    } as unknown as SupabaseClient

    const result = await listUserFacilities(db, 'u-2')
    expect(result).toEqual([])
  })

  it('不正なrole値が来てもstaffにフォールバックする', async () => {
    const rows = [{ facility_id: 'f-3', role: 'unknown', facilities: { name: '病院C' } }]
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: rows, error: null }),
        })),
      })),
    } as unknown as SupabaseClient

    const result = await listUserFacilities(db, 'u-3')
    expect(result[0].role).toBe('staff')
  })

  it('エラー時は例外を投げる', async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }),
        })),
      })),
    } as unknown as SupabaseClient

    await expect(listUserFacilities(db, 'u-4')).rejects.toThrow('DB error')
  })
})
