// WHY: requireAdmin() のDB roleベース判定を網羅的にテスト
//      ADMIN_EMAILSフォールバックとDBアドミン判定の両方が正しく動くことを保証する
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: vi.fn(),
  createAdminSupabase: vi.fn(),
}))

import { createServerSupabase, createAdminSupabase } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/admin-auth'

const USER_ID = 'user-123'
const USER_EMAIL = 'user@example.com'
const ADMIN_EMAIL = 'admin@example.com'

function makeUser(id = USER_ID, email = USER_EMAIL) {
  return { id, email }
}

function makeServerDb(user: ReturnType<typeof makeUser> | null) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    },
  }
}

// adminDb のモック: 2つのクエリに対応
// クエリ1: user_id+role='admin' チェック（.eq('user_id').eq('role').limit()）
// クエリ2: 全体admin存在チェック（.eq('role').limit()）
function makeAdminDb(userIsAdmin: boolean, anyAdminExists: boolean) {
  // from() が呼ばれるたびに呼び出しカウントを増やす
  let fromCallCount = 0
  return {
    from: vi.fn().mockImplementation(() => {
      fromCallCount++
      const call = fromCallCount
      if (call === 1) {
        // クエリ1: .select().eq('user_id').eq('role').limit()
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: userIsAdmin ? [{ user_id: USER_ID, role: 'admin' }] : [],
                  error: null,
                }),
              }),
            }),
          }),
        }
      } else {
        // クエリ2: .select().eq('role').limit()
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
      vi.mocked(createServerSupabase).mockResolvedValue(makeServerDb(user) as never)
      vi.mocked(createAdminSupabase).mockReturnValue(makeAdminDb(true, true) as never)

      const result = await requireAdmin()
      expect(result).not.toBeNull()
      expect(result?.id).toBe(USER_ID)
    })

    it('user_facilitiesにrole=adminがなければnullを返す（DBには他のadminが存在）', async () => {
      const user = makeUser(USER_ID, USER_EMAIL)
      vi.mocked(createServerSupabase).mockResolvedValue(makeServerDb(user) as never)
      // ユーザー自身はadminでないが、DBには別のadminが存在する
      vi.mocked(createAdminSupabase).mockReturnValue(makeAdminDb(false, true) as never)

      const result = await requireAdmin()
      expect(result).toBeNull()
    })
  })

  describe('DBにadminが0件の場合 → ADMIN_EMAILSフォールバック', () => {
    it('ADMIN_EMAILSに含まれるメールならユーザーを返す', async () => {
      process.env.ADMIN_EMAILS = ADMIN_EMAIL
      const user = makeUser(USER_ID, ADMIN_EMAIL)
      vi.mocked(createServerSupabase).mockResolvedValue(makeServerDb(user) as never)
      // DBにはadminが0件
      vi.mocked(createAdminSupabase).mockReturnValue(makeAdminDb(false, false) as never)

      const result = await requireAdmin()
      expect(result).not.toBeNull()
      expect(result?.email).toBe(ADMIN_EMAIL)
    })

    it('ADMIN_EMAILSに含まれないメールならnullを返す', async () => {
      process.env.ADMIN_EMAILS = ADMIN_EMAIL
      const user = makeUser(USER_ID, 'other@example.com')
      vi.mocked(createServerSupabase).mockResolvedValue(makeServerDb(user) as never)
      vi.mocked(createAdminSupabase).mockReturnValue(makeAdminDb(false, false) as never)

      const result = await requireAdmin()
      expect(result).toBeNull()
    })
  })

  describe('ADMIN_EMAILSが未設定かつDBにもadminがいない場合', () => {
    it('nullを返す', async () => {
      delete process.env.ADMIN_EMAILS
      const user = makeUser(USER_ID, USER_EMAIL)
      vi.mocked(createServerSupabase).mockResolvedValue(makeServerDb(user) as never)
      vi.mocked(createAdminSupabase).mockReturnValue(makeAdminDb(false, false) as never)

      const result = await requireAdmin()
      expect(result).toBeNull()
    })
  })

  describe('未ログインユーザー', () => {
    it('userがnullならnullを返す（DBクエリを呼ばない）', async () => {
      vi.mocked(createServerSupabase).mockResolvedValue(makeServerDb(null) as never)
      const adminDbMock = makeAdminDb(false, false)
      vi.mocked(createAdminSupabase).mockReturnValue(adminDbMock as never)

      const result = await requireAdmin()
      expect(result).toBeNull()
      // 未ログインの場合はDBに問い合わせない
      expect(adminDbMock.from).not.toHaveBeenCalled()
    })
  })
})
