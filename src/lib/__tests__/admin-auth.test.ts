// WHY: requireAdmin() のDB roleベース判定を網羅的にテスト
//      ADMIN_EMAILSフォールバックとDBアドミン判定の両方が正しく動くことを保証する
//      判定ロジックはresolveIsAdmin()（admin-status.ts）に一本化されているため、
//      ここではSECURITY DEFINER RPC(get_admin_status)の戻り値をモックする。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: vi.fn(),
}))

// WHY(2026-09-07 のミューテーション計測): 拒否の記録は「呼ばれたかどうか」ではなく
//      **中身**が効き目を持つ。guard / reason は access_denials の CHECK に載っている固定語彙で、
//      check_denial_anomalies（夜間の異常検知）はこの語彙で数えている。
//      ここを空文字や別の語に書き換えても全テストが通っていたので、記録の中身まで見る。
vi.mock('@/lib/security/access-denial', () => ({
  recordAccessDenial: vi.fn(),
}))

import { createServerSupabase } from '@/lib/supabase/server'
import { recordAccessDenial } from '@/lib/security/access-denial'
import { requireAdmin, assertAdminAal2 } from '@/lib/admin-auth'

const USER_ID = 'user-123'
const USER_EMAIL = 'user@example.com'
const ADMIN_EMAIL = 'admin@example.com'

function makeUser(id = USER_ID, email = USER_EMAIL) {
  return { id, email }
}

function makeServerDb(
  user: ReturnType<typeof makeUser> | null,
  userIsAdmin = false,
  dbHasAdmin = false
) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    },
    rpc: vi.fn().mockResolvedValue({
      data: [{ user_is_admin: userIsAdmin, db_has_admin: dbHasAdmin }],
      error: null,
    }),
  }
}

describe('requireAdmin', () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env.ADMIN_EMAILS = originalAdminEmails
  })

  describe('DBにadmin roleが存在する場合', () => {
    it('user_facilitiesにrole=adminの行があればユーザーを返す', async () => {
      const user = makeUser(USER_ID, USER_EMAIL)
      vi.mocked(createServerSupabase).mockResolvedValue(makeServerDb(user, true, true) as never)

      const result = await requireAdmin()
      expect(result).not.toBeNull()
      expect(result?.id).toBe(USER_ID)
    })

    it('user_facilitiesにrole=adminがなければnullを返す（DBには他のadminが存在）', async () => {
      const user = makeUser(USER_ID, USER_EMAIL)
      // ユーザー自身はadminでないが、DBには別のadminが存在する
      vi.mocked(createServerSupabase).mockResolvedValue(makeServerDb(user, false, true) as never)

      const result = await requireAdmin()
      expect(result).toBeNull()
      expect(recordAccessDenial).toHaveBeenCalledWith({
        guard: 'admin', reason: 'not_admin', actorId: USER_ID,
      })
    })
  })

  describe('DBにadminが0件の場合 → ADMIN_EMAILSフォールバック', () => {
    it('ADMIN_EMAILSに含まれるメールならユーザーを返す', async () => {
      process.env.ADMIN_EMAILS = ADMIN_EMAIL
      const user = makeUser(USER_ID, ADMIN_EMAIL)
      // DBにはadminが0件
      vi.mocked(createServerSupabase).mockResolvedValue(makeServerDb(user, false, false) as never)

      const result = await requireAdmin()
      expect(result).not.toBeNull()
      expect(result?.email).toBe(ADMIN_EMAIL)
      // 通した場合は拒否を記録しない（記録が水増しされると異常検知が鈍る）
      expect(recordAccessDenial).not.toHaveBeenCalled()
    })

    it('ADMIN_EMAILSに含まれないメールならnullを返す', async () => {
      process.env.ADMIN_EMAILS = ADMIN_EMAIL
      const user = makeUser(USER_ID, 'other@example.com')
      vi.mocked(createServerSupabase).mockResolvedValue(makeServerDb(user, false, false) as never)

      const result = await requireAdmin()
      expect(result).toBeNull()
    })
  })

  describe('ADMIN_EMAILSが未設定かつDBにもadminがいない場合', () => {
    it('nullを返す', async () => {
      delete process.env.ADMIN_EMAILS
      const user = makeUser(USER_ID, USER_EMAIL)
      vi.mocked(createServerSupabase).mockResolvedValue(makeServerDb(user, false, false) as never)

      const result = await requireAdmin()
      expect(result).toBeNull()
    })
  })

  describe('未ログインユーザー', () => {
    it('getUser が error を返したら未認証として扱う（fail-closed・#757-31）', async () => {
      const serverDb = makeServerDb(makeUser())
      serverDb.auth.getUser = vi.fn().mockResolvedValue({
        data: { user: null }, error: { message: 'auth service down' },
      })
      vi.mocked(createServerSupabase).mockResolvedValue(serverDb as never)

      expect(await requireAdmin()).toBeNull()
      expect(recordAccessDenial).toHaveBeenCalledWith({
        guard: 'admin', reason: 'unauthenticated',
      })
    })

    it('userがnullならnullを返す（RPCを呼ばない）', async () => {
      const serverDb = makeServerDb(null)
      vi.mocked(createServerSupabase).mockResolvedValue(serverDb as never)

      const result = await requireAdmin()
      expect(result).toBeNull()
      // 未ログインの場合はRPCに問い合わせない
      expect(serverDb.rpc).not.toHaveBeenCalled()
      expect(recordAccessDenial).toHaveBeenCalledWith({
        guard: 'admin', reason: 'unauthenticated',
      })
    })
  })
})

// WHY(W-011): Supabase Auth の管理 API は service_role でしか呼べず、RLS のトランザクションに
//      統合できない。経路そのものを消せないので「特権操作を呼ぶ直前にもう一度確かめる」で
//      窓を狭めている。その再確認が **fail-closed であること**と、**弾いた分が正しい語彙で
//      記録されること**をここで固定する。
//      2026-09-07 のミューテーション計測では、この関数の 35 変異が 1 件もテストに触れておらず
//      （NoCoverage）、`return false` を `return true` に書き換えても全テストが緑だった。
//      つまり「確かめずに特権操作を通す」に化けても気づけない状態だった。
describe('assertAdminAal2', () => {
  const ACTOR = USER_ID

  type Aal2Opts = {
    user?: ReturnType<typeof makeUser> | null
    getUserError?: unknown
    userIsAdmin?: boolean
    dbHasAdmin?: boolean
    aal2?: unknown
    aal2Error?: unknown
  }

  /** get_admin_status と has_aal2 を関数名で振り分けるモック */
  function makeAal2Db(opts: Aal2Opts) {
    const {
      user = makeUser(), getUserError = null, userIsAdmin = true, dbHasAdmin = true,
      aal2Error = null,
    } = opts
    // WHY(既定値を分割代入で書かない): `aal2 = true` と書くと **省略した**場合と
    //      **明示的に undefined を渡した**場合が区別できず、「has_aal2 が undefined」の
    //      ケースが黙って「true」に化けていた（この一行を書き分けるまでテストが緑だった）。
    const aal2 = 'aal2' in opts ? opts.aal2 : true
    const rpc = vi.fn().mockImplementation((name: string) => {
      if (name === 'has_aal2') return Promise.resolve({ data: aal2, error: aal2Error })
      return Promise.resolve({
        data: [{ user_is_admin: userIsAdmin, db_has_admin: dbHasAdmin }],
        error: null,
      })
    })
    return {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: getUserError }) },
      rpc,
    }
  }

  function use(opts: Aal2Opts) {
    const db = makeAal2Db(opts)
    vi.mocked(createServerSupabase).mockResolvedValue(db as never)
    return db
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('admin かつ aal2 なら true を返し、拒否を記録しない', async () => {
    const db = use({})
    expect(await assertAdminAal2(ACTOR)).toBe(true)
    expect(db.rpc).toHaveBeenCalledWith('has_aal2')
    // 通した分まで記録すると、拒否の並びから乗っ取りを読む検知が鈍る
    expect(recordAccessDenial).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'getUser が error を返す（認証 API が落ちている）',
      opts: { getUserError: { message: 'down' } },
      reason: 'unauthenticated',
    },
    { label: 'user が null（セッションが切れた）', opts: { user: null }, reason: 'unauthenticated' },
    {
      // WHY: ハンドラ先頭で見た actorId と、直前に見た実際の利用者がずれていたら通さない。
      //      この照合を外すと「別人の ID を渡して特権操作を通す」が成立する。
      label: 'actorId と実際の利用者が違う',
      opts: { user: makeUser('someone-else', USER_EMAIL) },
      reason: 'unauthenticated',
    },
    {
      label: '判定の間に admin を外された',
      opts: { userIsAdmin: false, dbHasAdmin: true },
      reason: 'not_admin',
    },
    {
      label: 'has_aal2 が error を返す（判定できない → 通さない）',
      opts: { aal2Error: { message: 'rpc failed' } },
      reason: 'aal2_required',
    },
    { label: 'has_aal2 が false', opts: { aal2: false }, reason: 'aal2_required' },
    {
      // WHY(`data !== true` を `!data` や `data === false` にしない): RPC が null や undefined を
      //      返すのは「まだ分からない」であって「aal2 である」ではない。true 以外は全部落とす。
      label: 'has_aal2 が null（真偽が返ってこない）',
      opts: { aal2: null },
      reason: 'aal2_required',
    },
    { label: 'has_aal2 が undefined', opts: { aal2: undefined }, reason: 'aal2_required' },
    {
      label: 'has_aal2 が truthy な非 boolean（文字列の "true"）',
      opts: { aal2: 'true' },
      reason: 'aal2_required',
    },
  ])('$label → false（reason=$reason で記録する）', async ({ opts, reason }) => {
    use(opts)
    expect(await assertAdminAal2(ACTOR)).toBe(false)
    expect(recordAccessDenial).toHaveBeenCalledWith({
      guard: 'admin', reason, actorId: ACTOR,
    })
  })

  it('admin でなければ has_aal2 を呼ばない（弾く順序を保つ）', async () => {
    const db = use({ userIsAdmin: false, dbHasAdmin: true })
    expect(await assertAdminAal2(ACTOR)).toBe(false)
    expect(db.rpc).not.toHaveBeenCalledWith('has_aal2')
  })

  it('未認証なら admin 判定も aal2 判定も行わない', async () => {
    const db = use({ user: null })
    expect(await assertAdminAal2(ACTOR)).toBe(false)
    expect(db.rpc).not.toHaveBeenCalled()
  })
})
