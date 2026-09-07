// WHY: requireFacilityAccess()のadmin判定はresolveIsAdmin()（admin-status.ts）に
//      一本化されているため、db.rpc('get_admin_status')（引数なし。issue #642由来の
//      認可バイパス修正でp_user_id引数を廃止しauth.uid()採用に変更済み）と
//      db.rpc('is_facility_member', ...)の両方を1つのdbモックで切り替えて返す。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient, User } from '@supabase/supabase-js'

// WHY(2026-09-07 のミューテーション計測): このファイルの効き目は 72% で、生き残り 7 件のうち
//      6 件が「拒否の記録の中身」だった。guard / reason / actorId / facilityId を空文字や
//      空オブジェクトに書き換えても全テストが緑で、access_denials の語彙が黙って壊せた。
//      その語彙は check_denial_anomalies（夜間の異常検知）が数えているので、
//      壊れると「誰がどの境界で弾かれたか」が読めなくなる。中身まで固定する。
vi.mock('@/lib/security/access-denial', () => ({
  recordAccessDenial: vi.fn(),
}))

import { recordAccessDenial } from '@/lib/security/access-denial'
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
    rpc: vi.fn().mockImplementation((fnName: string, args?: unknown) => {
      if (fnName === 'get_admin_status') {
        return Promise.resolve({
          data: [{ user_is_admin: userIsAdmin, db_has_admin: dbHasAdmin }],
          error: null,
        })
      }
      if (fnName === 'is_facility_member') {
        // WHY(引数を見る): 以前は第 2 引数を無視していたため、
        //      `db.rpc('is_facility_member', { p_facility_id: facilityId })` を
        //      `db.rpc('is_facility_member', {})` に書き換えても全テストが通っていた。
        //      本番なら「どの施設か言わずに所属を尋ねる」呼び出しになる。
        //      問い合わせた施設が要求された施設と一致したときだけ所属を返す。
        const asked = (args as { p_facility_id?: unknown } | undefined)?.p_facility_id
        return Promise.resolve({
          data: isMember && asked === FACILITY_ID,
          error: memberRpcError,
        })
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
      expect(recordAccessDenial).toHaveBeenCalledWith({
        guard: 'facility', reason: 'facility_id_required', actorId: 'u-user',
      })
    })

    it('メンバーなら facilityId を返す', async () => {
      const db = makeDb({ isMember: true })
      const result = await requireFacilityAccess(db, user, FACILITY_ID)
      expect(result).toEqual({ facilityId: FACILITY_ID })
      // 通した分は記録しない（記録が水増しされると拒否の並びから兆候が読めなくなる）
      expect(recordAccessDenial).not.toHaveBeenCalled()
    })

    it('所属確認は「どの施設か」を渡して行う', async () => {
      const db = makeDb({ isMember: true })
      await requireFacilityAccess(db, user, FACILITY_ID)
      expect(db.rpc).toHaveBeenCalledWith('is_facility_member', { p_facility_id: FACILITY_ID })
    })

    it('非メンバーなら FORBIDDEN をスロー', async () => {
      const db = makeDb({ isMember: false })
      await expect(requireFacilityAccess(db, user, FACILITY_ID))
        .rejects.toThrow('FORBIDDEN')
      expect(recordAccessDenial).toHaveBeenCalledWith({
        guard: 'facility', reason: 'forbidden', actorId: 'u-user', facilityId: FACILITY_ID,
      })
    })

    it('RPC error のとき FORBIDDEN をスロー', async () => {
      const db = makeDb({ isMember: false, memberRpcError: new Error('rpc error') })
      await expect(requireFacilityAccess(db, user, FACILITY_ID))
        .rejects.toThrow('FORBIDDEN')
      expect(recordAccessDenial).toHaveBeenCalledWith({
        guard: 'facility', reason: 'forbidden', actorId: 'u-user', facilityId: FACILITY_ID,
      })
    })
  })
})
