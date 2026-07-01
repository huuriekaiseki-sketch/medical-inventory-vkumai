import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { middleware } from '../middleware'
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

// DB roleチェック用のmockヘルパー
function makeSupabaseClientWithAdminRole(user: { id: string; email: string } | null, isAdminInDb: boolean) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValueOnce({ data: { user } }),
    },
    from: vi.fn().mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: isAdminInDb ? [{ user_id: user?.id, role: 'admin' }] : [],
              error: null,
            }),
          }),
        }),
      }),
    })),
  }
}

describe('middleware', () => {
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

      const response = await middleware(request)

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

      const response = await middleware(request)

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

      const response = await middleware(request)

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
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/facilities')
      )

      const response = await middleware(request)

      // 認証済みなのでリダイレクトされない
      expect(response?.status).not.toBe(307)
    })
  })

  describe('admin ガード（DBロールベース）', () => {
    it('ADMIN_EMAILSに含まれてもDBにrole=adminがなければ /login にリダイレクト', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({
            data: { user: { id: 'admin-1', email: 'admin@example.com' } },
          }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/settings')
      )

      const response = await middleware(request)

      expect(response?.status).toBe(307)
    })

    it('非 admin メールのユーザーが /admin/settings にアクセス→ /login にリダイレクト', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({
            data: { user: { id: 'user-1', email: 'user@example.com' } },
          }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/settings')
      )

      const response = await middleware(request)

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

      const response = await middleware(request)

      expect(response?.status).toBe(307)
    })

    it('DBにrole=adminがあるユーザーが /admin/* にアクセス→ そのまま通す', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({
            data: { user: { id: 'admin-2', email: 'admin@example.com' } },
          }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [{ user_id: 'admin-2', role: 'admin' }],
                  error: null,
                }),
              }),
            }),
          }),
        }),
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/users')
      )

      const response = await middleware(request)

      expect(response?.status).not.toBe(307)
    })

    it('ADMIN_EMAILS が未設定でも動作する（DBにもadminなし→リダイレクト）', async () => {
      delete process.env.ADMIN_EMAILS
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({
            data: { user: { id: 'user-1', email: 'user@example.com' } },
          }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/settings')
      )

      const response = await middleware(request)

      // ADMIN_EMAILS が空なので admin チェック失敗→ リダイレクト
      expect(response?.status).toBe(307)
    })
  })

  describe('admin ガード（DBロールベース）', () => {
    it('user_facilitiesにrole=adminがあれば /admin/* を通す', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      // DB roleチェックが2回（user+role確認 → 全体admin存在確認）
      let fromCallCount = 0
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({
            data: { user: { id: 'db-admin-1', email: 'dbadmin@example.com' } },
          }),
        },
        from: vi.fn().mockImplementation(() => {
          fromCallCount++
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [{ user_id: 'db-admin-1', role: 'admin' }],
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }),
      } as unknown as ReturnType<typeof createServerClient>)

      // DB adminには含まれないメール
      process.env.ADMIN_EMAILS = 'other@example.com'

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/settings')
      )

      const response = await middleware(request)

      expect(response?.status).not.toBe(307)
    })

    it('user_facilitiesにrole=adminがなくADMIN_EMAILSにも含まれなければリダイレクト', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({
            data: { user: { id: 'regular-user', email: 'regular@example.com' } },
          }),
        },
        from: vi.fn().mockImplementation(() => ({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        })),
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/settings')
      )

      const response = await middleware(request)

      expect(response?.status).toBe(307)
    })
  })

  describe('updateSession（トークンリフレッシュ）', () => {
    it('middleware が cookie セットを呼び出す', async () => {
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

      const response = await middleware(request)

      // レスポンスは正常に返される
      expect(response).toBeInstanceOf(NextResponse)
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
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/adminfoo')
      )

      const response = await middleware(request)

      // /adminfoo は admin パスではないので、通常のみドルウェアロジック通す
      expect(response).toBeInstanceOf(NextResponse)
    })
  })
})
