import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// exchangeCodeForSession のモック
const mockExchangeCodeForSession = vi.fn()
const mockCreateServerClient = vi.fn()

vi.mock('@supabase/ssr', () => ({
  createServerClient: mockCreateServerClient,
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve({
    getAll: vi.fn().mockReturnValue([]),
    set: vi.fn(),
  })),
}))

// GET 関数を直接インポート
async function importGET() {
  const mod = await import('../app/auth/callback/route')
  return mod.GET
}

describe('auth/callback route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
  })

  describe('code パラメータなし', () => {
    it('code がない場合は /login?error=auth にリダイレクト', async () => {
      mockCreateServerClient.mockReturnValue({
        auth: {
          exchangeCodeForSession: mockExchangeCodeForSession,
        },
      })

      const { GET } = await import('@/app/auth/callback/route')
      const request = new NextRequest('http://localhost:3000/auth/callback')

      const response = await GET(request)

      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toContain('/login?error=auth')
    })
  })

  describe('code パラメータあり（成功）', () => {
    it('code 交換が成功した場合は / にリダイレクト', async () => {
      mockExchangeCodeForSession.mockResolvedValueOnce({ error: null })
      mockCreateServerClient.mockReturnValue({
        auth: {
          exchangeCodeForSession: mockExchangeCodeForSession,
        },
      })

      const { GET } = await import('@/app/auth/callback/route')
      const request = new NextRequest('http://localhost:3000/auth/callback?code=valid-code')

      const response = await GET(request)

      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toBe('http://localhost:3000/')
    })

    it('exchangeCodeForSession が code を引数として呼ばれる', async () => {
      mockExchangeCodeForSession.mockResolvedValueOnce({ error: null })
      mockCreateServerClient.mockReturnValue({
        auth: {
          exchangeCodeForSession: mockExchangeCodeForSession,
        },
      })

      const { GET } = await import('@/app/auth/callback/route')
      const request = new NextRequest('http://localhost:3000/auth/callback?code=test-code-123')

      await GET(request)

      expect(mockExchangeCodeForSession).toHaveBeenCalledWith('test-code-123')
    })
  })

  describe('code パラメータあり（失敗）', () => {
    it('code 交換が失敗した場合は /login?error=auth にリダイレクト', async () => {
      mockExchangeCodeForSession.mockResolvedValueOnce({ error: new Error('invalid code') })
      mockCreateServerClient.mockReturnValue({
        auth: {
          exchangeCodeForSession: mockExchangeCodeForSession,
        },
      })

      const { GET } = await import('@/app/auth/callback/route')
      const request = new NextRequest('http://localhost:3000/auth/callback?code=bad-code')

      const response = await GET(request)

      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toContain('/login?error=auth')
    })
  })
})
