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
import { AUTH_JUDGMENT_TIMEOUT_MS } from '@/lib/security/judgment-timeout'

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

    // WHY(#757-31): PostgREST を止めた実測でこの RPC が **55 秒**返らなかった。
    //      上限で諦めたときに通すと、依存が落ちている間だけ他施設に届く
    it('所属の RPC が返ってこないときは上限で諦めて FORBIDDEN（依存が落ちている間だけ通らない）', async () => {
      vi.useFakeTimers()
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const db = {
          rpc: vi.fn().mockImplementation((fnName: string) => {
            if (fnName === 'get_admin_status') {
              return Promise.resolve({ data: [{ user_is_admin: false, db_has_admin: true }], error: null })
            }
            return new Promise(() => {}) // is_facility_member が返ってこない
          }),
        } as unknown as SupabaseClient
        const promise = requireFacilityAccess(db, user, FACILITY_ID)
        const assertion = expect(promise).rejects.toThrow('FORBIDDEN')
        await vi.advanceTimersByTimeAsync(AUTH_JUDGMENT_TIMEOUT_MS)
        await assertion
        expect(recordAccessDenial).toHaveBeenCalledWith({
          guard: 'facility', reason: 'forbidden', actorId: 'u-user', facilityId: FACILITY_ID,
        })
        // 諦めたことと**どの判定か**が記録に残る
        const printed = JSON.stringify(spy.mock.calls)
        expect(printed).toContain('judgment-timeout')
        expect(printed).toContain('rpc.is_facility_member')
      } finally {
        spy.mockRestore()
        vi.useRealTimers()
      }
    })
  })
})

// P-002 の補足（2026-09-13）: 一覧 route は admin でも facility_id を必須にできる（facilityIdRequired）。
// 実測: admin が facility_id 無しで一覧 GET 5 本を呼ぶと、repository が `.eq('facility_id', undefined)` を
// 組み立てて PostgREST の uuid 変換で 500 になっていた（/api/orders だけが 400、hospital-prices は 200 と不揃い）。
describe('requireFacilityAccess の facilityIdRequired（一覧 route の契約） [P-002]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('admin でも facilityIdRequired なら facilityId=null は FACILITY_ID_REQUIRED（拒否ではないので記録しない）', async () => {
    const db = makeDb({ userIsAdmin: true, dbHasAdmin: true })
    await expect(
      requireFacilityAccess(db, makeUser('u-admin', 'admin@test.com'), null, { facilityIdRequired: true })
    ).rejects.toThrow('FACILITY_ID_REQUIRED')
    expect(recordAccessDenial).not.toHaveBeenCalled()
  })

  it('admin で facilityIdRequired でも facilityId があれば通る（RPC は呼ばない）', async () => {
    const db = makeDb({ userIsAdmin: true, dbHasAdmin: true })
    await expect(
      requireFacilityAccess(db, makeUser('u-admin', 'admin@test.com'), FACILITY_ID, { facilityIdRequired: true })
    ).resolves.toEqual({ facilityId: FACILITY_ID })
    expect(db.rpc).not.toHaveBeenCalledWith('is_facility_member', expect.anything())
  })

  it('facilityIdRequired を渡さなければ admin の facilityId=null は今まで通り通る（hospital-prices / news の契約）', async () => {
    const db = makeDb({ userIsAdmin: true, dbHasAdmin: true })
    await expect(
      requireFacilityAccess(db, makeUser('u-admin', 'admin@test.com'), null)
    ).resolves.toEqual({ facilityId: null })
  })

  it('非 admin の facilityId=null は facilityIdRequired の有無に関わらず記録して FACILITY_ID_REQUIRED', async () => {
    const db = makeDb({ isMember: true })
    await expect(
      requireFacilityAccess(db, makeUser('u-user', 'user@test.com'), null, { facilityIdRequired: true })
    ).rejects.toThrow('FACILITY_ID_REQUIRED')
    expect(recordAccessDenial).toHaveBeenCalledWith({
      guard: 'facility', reason: 'facility_id_required', actorId: 'u-user',
    })
  })
})
