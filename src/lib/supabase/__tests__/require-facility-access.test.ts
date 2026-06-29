import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'

const FACILITY_ID = 'f-123'

function makeUser(email: string): User {
  return { id: 'u-1', email } as User
}

function makeDb(isMember: boolean, rpcError: Error | null = null): SupabaseClient {
  return {
    rpc: vi.fn().mockResolvedValue({ data: isMember, error: rpcError }),
  } as unknown as SupabaseClient
}

describe('requireFacilityAccess', () => {
  const originalEnv = process.env.ADMIN_EMAILS

  beforeEach(() => {
    process.env.ADMIN_EMAILS = 'admin@example.com'
  })

  afterEach(() => {
    process.env.ADMIN_EMAILS = originalEnv
  })

  describe('admin ユーザー', () => {
    const admin = makeUser('admin@example.com')

    it('facilityId=null でも通す', async () => {
      const result = await requireFacilityAccess(makeDb(false), admin, null)
      expect(result).toEqual({ facilityId: null })
    })

    it('facilityId 指定でも通す', async () => {
      const result = await requireFacilityAccess(makeDb(true), admin, FACILITY_ID)
      expect(result).toEqual({ facilityId: FACILITY_ID })
    })

    it('RPC を呼ばない', async () => {
      const db = makeDb(true)
      await requireFacilityAccess(db, admin, null)
      expect(db.rpc).not.toHaveBeenCalled()
    })
  })

  describe('非 admin ユーザー', () => {
    const user = makeUser('user@example.com')

    it('facilityId=null のとき FACILITY_ID_REQUIRED をスロー', async () => {
      await expect(requireFacilityAccess(makeDb(true), user, null))
        .rejects.toThrow('FACILITY_ID_REQUIRED')
    })

    it('メンバーなら facilityId を返す', async () => {
      const result = await requireFacilityAccess(makeDb(true), user, FACILITY_ID)
      expect(result).toEqual({ facilityId: FACILITY_ID })
    })

    it('非メンバーなら FORBIDDEN をスロー', async () => {
      await expect(requireFacilityAccess(makeDb(false), user, FACILITY_ID))
        .rejects.toThrow('FORBIDDEN')
    })

    it('RPC error のとき FORBIDDEN をスロー', async () => {
      await expect(requireFacilityAccess(makeDb(false, new Error('rpc error')), user, FACILITY_ID))
        .rejects.toThrow('FORBIDDEN')
    })
  })
})
