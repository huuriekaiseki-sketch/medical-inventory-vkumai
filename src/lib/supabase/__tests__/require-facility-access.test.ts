// WHY: requireFacilityAccess()のadmin判定はresolveIsAdmin()（admin-status.ts）に
//      一本化されているため、db.rpc('get_admin_status')（引数なし。issue #642由来の
//      認可バイパス修正でp_user_id引数を廃止しauth.uid()採用に変更済み）と
//      db.rpc('is_facility_member', ...)の両方を1つのdbモックで切り替えて返す。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'

const FACILITY_ID = 'f-123'

function makeUser(id: string, email: string): User {
  return { id, email } as User
}

function makeDb(
  opts: {
    userIsAdmin?: boolean
    dbHasAdmin?: boolean
    isMember?: boolean
    memberRpcError?: Error | null
  }
): SupabaseClient {
  const { userIsAdmin = false, dbHasAdmin = false, isMember = false, memberRpcError = null } = opts
  return {
    rpc: vi.fn().mockImplementation((fnName: string) => {
      if (fnName === 'get_admin_status') {
        return Promise.resolve({
          data: [{ user_is_admin: userIsAdmin, db_has_admin: dbHasAdmin }],
          error: null,
        })
      }
      if (fnName === 'is_facility_member') {
        return Promise.resolve({ data: isMember, error: memberRpcError })
      }
      return Promise.resolve({ data: null, error: new Error('unknown rpc') })
    }),
  } as unknown as SupabaseClient
}

// P-002（docs/agents/promise-catalog.md）: 施設非所属は FORBIDDEN、admin は施設指定なしでも通る
describe('requireFacilityAccess (P-002)', () => {
  const originalEnv = process.env.ADMIN_EMAILS

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env.ADMIN_EMAILS = originalEnv
  })

  describe('admin ユーザー（ADMIN_EMAILSフォールバック）', () => {
    beforeEach(() => {
      process.env.ADMIN_EMAILS = 'admin@example.com'
    })

    const admin = makeUser('u-admin', 'admin@example.com')

    it('facilityId=null でも通す', async () => {
      const db = makeDb({ userIsAdmin: false, dbHasAdmin: false, isMember: false })
      const result = await requireFacilityAccess(db, admin, null)
      expect(result).toEqual({ facilityId: null })
    })

    it('facilityId 指定でも通す', async () => {
      const db = makeDb({ userIsAdmin: false, dbHasAdmin: false, isMember: true })
      const result = await requireFacilityAccess(db, admin, FACILITY_ID)
      expect(result).toEqual({ facilityId: FACILITY_ID })
    })

    it('is_facility_member RPC を呼ばない', async () => {
      const db = makeDb({ userIsAdmin: false, dbHasAdmin: false, isMember: true })
      await requireFacilityAccess(db, admin, null)
      expect(db.rpc).toHaveBeenCalledWith('get_admin_status')
      expect(db.rpc).not.toHaveBeenCalledWith('is_facility_member', expect.anything())
    })
  })

  describe('admin ユーザー（DBロールベース）', () => {
    beforeEach(() => {
      delete process.env.ADMIN_EMAILS
    })

    const admin = makeUser('u-admin', 'admin@example.com')

    it('facilityId=null でも通す', async () => {
      const db = makeDb({ userIsAdmin: true, dbHasAdmin: true, isMember: false })
      const result = await requireFacilityAccess(db, admin, null)
      expect(result).toEqual({ facilityId: null })
    })
  })

  describe('非 admin ユーザー', () => {
    beforeEach(() => {
      process.env.ADMIN_EMAILS = 'admin@example.com'
    })

    const user = makeUser('u-user', 'user@example.com')

    it('facilityId=null のとき FACILITY_ID_REQUIRED をスロー', async () => {
      const db = makeDb({ isMember: true })
      await expect(requireFacilityAccess(db, user, null))
        .rejects.toThrow('FACILITY_ID_REQUIRED')
    })

    it('メンバーなら facilityId を返す', async () => {
      const db = makeDb({ isMember: true })
      const result = await requireFacilityAccess(db, user, FACILITY_ID)
      expect(result).toEqual({ facilityId: FACILITY_ID })
    })

    it('非メンバーなら FORBIDDEN をスロー', async () => {
      const db = makeDb({ isMember: false })
      await expect(requireFacilityAccess(db, user, FACILITY_ID))
        .rejects.toThrow('FORBIDDEN')
    })

    it('RPC error のとき FORBIDDEN をスロー', async () => {
      const db = makeDb({ isMember: false, memberRpcError: new Error('rpc error') })
      await expect(requireFacilityAccess(db, user, FACILITY_ID))
        .rejects.toThrow('FORBIDDEN')
    })
  })
})
