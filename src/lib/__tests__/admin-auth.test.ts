// WHY: requireAdmin() のDB roleベース判定を網羅的にテスト
//      ADMIN_EMAILSフォールバックとDBアドミン判定の両方が正しく動くことを保証する
//      判定ロジックはresolveIsAdmin()（admin-status.ts）に一本化されているため、
//      ここではSECURITY DEFINER RPC(get_admin_status)の戻り値をモックする。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: vi.fn(),
}))

import { createServerSupabase } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/admin-auth'

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
    it('userがnullならnullを返す（RPCを呼ばない）', async () => {
      const serverDb = makeServerDb(null)
      vi.mocked(createServerSupabase).mockResolvedValue(serverDb as never)

      const result = await requireAdmin()
      expect(result).toBeNull()
      // 未ログインの場合はRPCに問い合わせない
      expect(serverDb.rpc).not.toHaveBeenCalled()
    })
  })
})
