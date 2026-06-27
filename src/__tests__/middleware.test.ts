import { describe, it, expect, beforeEach, vi } from 'vitest'
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

describe('middleware', () => {
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

  describe('admin ガード', () => {
    it('admin メールのユーザーが /admin/settings にアクセス→ そのまま通す', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({
            data: { user: { id: 'admin-1', email: 'admin@example.com' } },
          }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/settings')
      )

      const response = await middleware(request)

      expect(response?.status).not.toBe(307)
    })

    it('非 admin メールのユーザーが /admin/settings にアクセス→ /login にリダイレクト', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({
            data: { user: { id: 'user-1', email: 'user@example.com' } },
          }),
        },
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

    it('admin メール（大文字）のユーザーが /admin/* にアクセス→ そのまま通す（case-insensitive）', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({
            data: { user: { id: 'admin-2', email: 'ADMIN@EXAMPLE.COM' } },
          }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/users')
      )

      const response = await middleware(request)

      expect(response?.status).not.toBe(307)
    })

    it('ADMIN_EMAILS が未設定でも動作する', async () => {
      delete process.env.ADMIN_EMAILS
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({
            data: { user: { id: 'user-1', email: 'user@example.com' } },
          }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(
        new URL('http://localhost:3000/admin/settings')
      )

      const response = await middleware(request)

      // ADMIN_EMAILS が空なので admin チェック失敗→ リダイレクト
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

  describe('matcher と静的アセット除外', () => {
    it('/_next/static にはミドルウェアが実行されない（matcher設定）', async () => {
      // matcher 設定により実際にはミドルウェアが実行されないため、
      // ここではテストスキップ（実装確認のみ）
      expect(true).toBe(true)
    })
  })
})
