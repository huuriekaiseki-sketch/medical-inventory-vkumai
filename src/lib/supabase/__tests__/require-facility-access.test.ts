import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient, User } from '@supabase/supabase-js'

vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabase: vi.fn(),
}))

import { createAdminSupabase } from '@/lib/supabase/server'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'

const FACILITY_ID = 'f-123'

function makeUser(id: string, email: string): User {
  return { id, email } as User
}

function makeRpcDb(isMember: boolean, rpcError: Error | null = null): SupabaseClient {
  return {
    rpc: vi.fn().mockResolvedValue({ data: isMember, error: rpcError }),
  } as unknown as SupabaseClient
}

// adminDbのモック: 2クエリ対応（user+role確認 → 全体admin存在確認）
function makeAdminDb(userIsAdmin: boolean, anyAdminExists: boolean) {
  let fromCallCount = 0
  return {
    from: vi.fn().mockImplementation(() => {
      fromCallCount++
      if (fromCallCount === 1) {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: userIsAdmin ? [{ user_id: 'u-admin', role: 'admin' }] : [],
                  error: null,
                }),
              }),
            }),
          }),
        }
      } else {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: anyAdminExists ? [{ role: 'admin' }] : [],
                error: null,
              }),
            }),
          }),
        }
      }
    }),
  }
}


describe('requireFacilityAccess', () => {
  const originalEnv = process.env.ADMIN_EMAILS

  beforeEach(() => {
    vi.clearAllMocks()
    // DBにadminが0件 → ADMIN_EMAILSフォールバックで動作
    vi.mocked(createAdminSupabase).mockReturnValue(makeAdminDb(false, false) as never)
  })

  afterEach(() => {
    process.env.ADMIN_EMAILS = originalEnv
  })

  describe('admin ユーザー（ADMIN_EMAILSフォールバック）', () => {
    beforeEach(() => {
      process.env.ADMIN_EMAILS = 'admin@example.com'
      // admin判定: DBにadminが0件でADMIN_EMAILSフォールバック
      vi.mocked(createAdminSupabase).mockReturnValue(makeAdminDb(false, false) as never)
    })

    const admin = makeUser('u-admin', 'admin@example.com')

    it('facilityId=null でも通す', async () => {
      const result = await requireFacilityAccess(makeRpcDb(false), admin, null)
      expect(result).toEqual({ facilityId: null })
    })

    it('facilityId 指定でも通す', async () => {
      const result = await requireFacilityAccess(makeRpcDb(true), admin, FACILITY_ID)
      expect(result).toEqual({ facilityId: FACILITY_ID })
    })

    it('RPC を呼ばない', async () => {
      const db = makeRpcDb(true)
      await requireFacilityAccess(db, admin, null)
      expect(db.rpc).not.toHaveBeenCalled()
    })
  })

  describe('admin ユーザー（DBロールベース）', () => {
    beforeEach(() => {
      delete process.env.ADMIN_EMAILS
      vi.mocked(createAdminSupabase).mockReturnValue(makeAdminDb(true, true) as never)
    })

    const admin = makeUser('u-admin', 'admin@example.com')

    it('facilityId=null でも通す', async () => {
      const result = await requireFacilityAccess(makeRpcDb(false), admin, null)
      expect(result).toEqual({ facilityId: null })
    })
  })

  describe('非 admin ユーザー', () => {
    beforeEach(() => {
      process.env.ADMIN_EMAILS = 'admin@example.com'
      vi.mocked(createAdminSupabase).mockReturnValue(makeAdminDb(false, false) as never)
    })

    const user = makeUser('u-user', 'user@example.com')

    it('facilityId=null のとき FACILITY_ID_REQUIRED をスロー', async () => {
      await expect(requireFacilityAccess(makeRpcDb(true), user, null))
        .rejects.toThrow('FACILITY_ID_REQUIRED')
    })

    it('メンバーなら facilityId を返す', async () => {
      const result = await requireFacilityAccess(makeRpcDb(true), user, FACILITY_ID)
      expect(result).toEqual({ facilityId: FACILITY_ID })
    })

    it('非メンバーなら FORBIDDEN をスロー', async () => {
      await expect(requireFacilityAccess(makeRpcDb(false), user, FACILITY_ID))
        .rejects.toThrow('FORBIDDEN')
    })

    it('RPC error のとき FORBIDDEN をスロー', async () => {
      await expect(requireFacilityAccess(makeRpcDb(false, new Error('rpc error')), user, FACILITY_ID))
        .rejects.toThrow('FORBIDDEN')
    })
  })
})
