import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { listUserFacilities, getUserFacilityRole } from '@/lib/user-facilities/repository'

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

  it('viewerロールのユーザーはstaffに丸められずviewerのまま返す(issue #608)', async () => {
    const rows = [{ facility_id: 'f-5', role: 'viewer', facilities: { name: '病院E' } }]
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: rows, error: null }),
        })),
      })),
    } as unknown as SupabaseClient

    const result = await listUserFacilities(db, 'u-5')
    expect(result).toEqual([{ facilityId: 'f-5', facilityName: '病院E', role: 'viewer' }])
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

describe('getUserFacilityRole', () => {
  function buildDb(result: { data: unknown; error: unknown }) {
    const maybeSingle = vi.fn().mockResolvedValue(result)
    const eq2 = vi.fn(() => ({ maybeSingle }))
    const eq1 = vi.fn(() => ({ eq: eq2 }))
    const select = vi.fn(() => ({ eq: eq1 }))
    const from = vi.fn(() => ({ select }))
    return { from } as unknown as SupabaseClient
  }

  it('所属している場合はroleを返す', async () => {
    const db = buildDb({ data: { role: 'viewer' }, error: null })
    const role = await getUserFacilityRole(db, 'u-1', 'f-1')
    expect(role).toBe('viewer')
  })

  it('不正なrole値が来てもstaffにフォールバックする', async () => {
    const db = buildDb({ data: { role: 'unknown' }, error: null })
    const role = await getUserFacilityRole(db, 'u-1', 'f-1')
    expect(role).toBe('staff')
  })

  it('未所属の場合はnullを返す', async () => {
    const db = buildDb({ data: null, error: null })
    const role = await getUserFacilityRole(db, 'u-1', 'f-1')
    expect(role).toBeNull()
  })

  it('エラー時は例外を投げる', async () => {
    const db = buildDb({ data: null, error: { message: 'DB error' } })
    await expect(getUserFacilityRole(db, 'u-1', 'f-1')).rejects.toThrow('DB error')
  })
})
