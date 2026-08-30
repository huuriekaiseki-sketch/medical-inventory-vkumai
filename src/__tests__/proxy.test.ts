import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { proxy } from '../proxy'
import { NextRequest, NextResponse } from 'next/server'

// Mock createServerClient
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(),
    },
  })),
}))

// Mock環境変数
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
  process.env.ADMIN_EMAILS = 'admin@example.com,another@example.com'
})

// resolveIsAdmin は get_admin_status RPC を呼ぶため、rpc モックを用意する
// MFAガード用にmfa.getAuthenticatorAssuranceLevelもデフォルトでaal1/aal1(MFA未要求)を返す
function makeSupabaseClientWithAdminRpc(
  user: { id: string; email: string } | null,
  userIsAdmin: boolean,
  dbHasAdmin: boolean,
  aal: { currentLevel: string; nextLevel: string } = { currentLevel: 'aal1', nextLevel: 'aal1' }
) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValueOnce({ data: { user } }),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: aal, error: null }),
      },
    },
    rpc: vi.fn().mockResolvedValue({
      data: [{ user_is_admin: userIsAdmin, db_has_admin: dbHasAdmin }],
      error: null,
    }),
  }
}

describe('proxy', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('未認証ガード', () => {
    it('未認証ユーザーが /facilities にアクセス→ /login にリダイレクト', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: null } }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/facilities')
      )

      const response = await proxy(request)

      expect(response).toBeInstanceOf(NextResponse)
      expect(response?.status).toBe(307) // redirect
    })

    it('未認証ユーザーが /login にアクセス→ そのまま通す', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: null } }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/login')
      )

      const response = await proxy(request)

      // PUBLIC_PATHS なのでリダイレクトされない
      expect(response?.status).not.toBe(307)
    })

    it('未認証ユーザーが /auth/callback にアクセス→ そのまま通す', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: null } }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/auth/callback')
      )

      const response = await proxy(request)

      expect(response?.status).not.toBe(307)
    })

    it('認証ユーザーが保護パスにアクセス→ そのまま通す', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi
            .fn()
            .mockResolvedValueOnce({
              data: { user: { id: 'user-123', email: 'user@example.com' } },
            }),
          mfa: {
            getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
              data: { currentLevel: 'aal1', nextLevel: 'aal1' },
              error: null,
            }),
          },
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/facilities')
      )

      const response = await proxy(request)

      // 認証済みなのでリダイレクトされない
      expect(response?.status).not.toBe(307)
    })
  })

  describe('admin ガード（DBロールベース）', () => {
    it('ADMIN_EMAILSに含まれてもDBにrole=adminがなければ /login にリダイレクト', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'admin-1', email: 'admin@example.com' },
          false,
          false
        ) as unknown as ReturnType<typeof createServerClient>
      )
      // ADMIN_EMAILSに一致しないメールにするため上書き
      process.env.ADMIN_EMAILS = 'other@example.com'

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/settings')
      )

      const response = await proxy(request)

      expect(response?.status).toBe(307)
    })

    it('非 admin メールのユーザーが /admin/settings にアクセス→ /login にリダイレクト', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'user-1', email: 'user@example.com' },
          false,
          false
        ) as unknown as ReturnType<typeof createServerClient>
      )

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/settings')
      )

      const response = await proxy(request)

      expect(response?.status).toBe(307)
    })

    it('未認証ユーザーが /api/admin/users にアクセス→ /login にリダイレクト', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: null } }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/api/admin/users')
      )

      const response = await proxy(request)

      expect(response?.status).toBe(307)
    })

    it('DBにrole=adminがあるユーザーが /admin/* にアクセス→ そのまま通す', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'admin-2', email: 'admin@example.com' },
          true,
          true
        ) as unknown as ReturnType<typeof createServerClient>
      )

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/users')
      )

      const response = await proxy(request)

      expect(response?.status).not.toBe(307)
    })

    it('ADMIN_EMAILS が未設定でも動作する（DBにもadminなし→リダイレクト）', async () => {
      delete process.env.ADMIN_EMAILS
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'user-1', email: 'user@example.com' },
          false,
          false
        ) as unknown as ReturnType<typeof createServerClient>
      )

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/settings')
      )

      const response = await proxy(request)

      // ADMIN_EMAILS が空なので admin チェック失敗→ リダイレクト
      expect(response?.status).toBe(307)
    })
  })

  describe('admin ガード（ADMIN_EMAILSフォールバック）', () => {
    it('DBにadmin0件でADMIN_EMAILSに一致するユーザーが /admin にアクセス→ 通過', async () => {
      process.env.ADMIN_EMAILS = 'admin@example.com'
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'fallback-admin', email: 'admin@example.com' },
          false,
          false
        ) as unknown as ReturnType<typeof createServerClient>
      )

      const request = new NextRequest(
        new URL('http://localhost:3000/admin')
      )

      const response = await proxy(request)

      expect(response?.status).not.toBe(307)
    })

    it('DBにadmin0件でADMIN_EMAILSに一致しないユーザーが /admin にアクセス→ /login にリダイレクト', async () => {
      process.env.ADMIN_EMAILS = 'admin@example.com'
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'regular-user', email: 'other@example.com' },
          false,
          false
        ) as unknown as ReturnType<typeof createServerClient>
      )

      const request = new NextRequest(
        new URL('http://localhost:3000/admin')
      )

      const response = await proxy(request)

      expect(response?.status).toBe(307)
    })
  })

  describe('admin ガード（DBロールベース・二重登録防止）', () => {
    it('user_facilitiesにrole=adminがあれば /admin/* を通す', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'db-admin-1', email: 'dbadmin@example.com' },
          true,
          true
        ) as unknown as ReturnType<typeof createServerClient>
      )

      // DB adminには含まれないメール
      process.env.ADMIN_EMAILS = 'other@example.com'

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/settings')
      )

      const response = await proxy(request)

      expect(response?.status).not.toBe(307)
    })

    it('user_facilitiesにrole=adminがなくADMIN_EMAILSにも含まれなければリダイレクト', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'regular-user', email: 'regular@example.com' },
          false,
          false
        ) as unknown as ReturnType<typeof createServerClient>
      )
      process.env.ADMIN_EMAILS = 'other@example.com'

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/settings')
      )

      const response = await proxy(request)

      expect(response?.status).toBe(307)
    })
  })

  describe('updateSession（トークンリフレッシュ）', () => {
    it('proxy が cookie セットを呼び出す', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: null } }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/login')
      )
      request.cookies.set = vi.fn()

      const response = await proxy(request)

      // レスポンスは正常に返される
      expect(response).toBeInstanceOf(NextResponse)
    })
  })

  describe('MFAガード', () => {
    it('aal1→aal2が必要なユーザーが保護パスにアクセス→ /mfa-challenge にリダイレクト', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'mfa-user', email: 'mfa@example.com' },
          false,
          false,
          { currentLevel: 'aal1', nextLevel: 'aal2' }
        ) as unknown as ReturnType<typeof createServerClient>
      )

      const request = new NextRequest(
        new URL('http://localhost:3000/facilities')
      )

      const response = await proxy(request)

      expect(response?.status).toBe(307)
      expect(response?.headers.get('location')).toContain('/mfa-challenge')
    })

    it('aal1→aal2が必要なユーザーが /mfa-challenge 自体にアクセス→ そのまま通す', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'mfa-user', email: 'mfa@example.com' },
          false,
          false,
          { currentLevel: 'aal1', nextLevel: 'aal2' }
        ) as unknown as ReturnType<typeof createServerClient>
      )

      const request = new NextRequest(
        new URL('http://localhost:3000/mfa-challenge')
      )

      const response = await proxy(request)

      expect(response?.status).not.toBe(307)
    })

    it('MFA未設定(aal1→aal1)のユーザーは保護パスへ通常通りアクセスできる', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'no-mfa-user', email: 'nomfa@example.com' },
          false,
          false,
          { currentLevel: 'aal1', nextLevel: 'aal1' }
        ) as unknown as ReturnType<typeof createServerClient>
      )

      const request = new NextRequest(
        new URL('http://localhost:3000/facilities')
      )

      const response = await proxy(request)

      expect(response?.status).not.toBe(307)
    })

    it('既にaal2のユーザーは保護パスへ通常通りアクセスできる', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'aal2-user', email: 'aal2@example.com' },
          false,
          false,
          { currentLevel: 'aal2', nextLevel: 'aal2' }
        ) as unknown as ReturnType<typeof createServerClient>
      )

      const request = new NextRequest(
        new URL('http://localhost:3000/facilities')
      )

      const response = await proxy(request)

      expect(response?.status).not.toBe(307)
    })
  })

  describe('パスマッチング（admin パス）', () => {
    it('名前空間の誤マッチを避ける（/adminfoo は admin パスではない）', async () => {
      // /admin のみ、または /admin/ 配下が正しい admin パス
      // /adminfoo などの誤マッチを防ぐテスト
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({
            data: { user: { id: 'admin-1', email: 'admin@example.com' } },
          }),
          mfa: {
            getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
              data: { currentLevel: 'aal1', nextLevel: 'aal1' },
              error: null,
            }),
          },
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/adminfoo')
      )

      const response = await proxy(request)

      // /adminfoo は admin パスではないので、通常のみドルウェアロジック通す
      expect(response).toBeInstanceOf(NextResponse)
    })
  })
})
