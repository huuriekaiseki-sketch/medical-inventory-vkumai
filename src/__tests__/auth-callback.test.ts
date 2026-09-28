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

// WHY(サーバー側ログの唯一の出口を差し替える): 画面は一律「認証に失敗しました」しか出さないので、
//      失敗理由が内側のログに残ることをここで固定する。実物の console.error を spy するのではなく
//      log-safe の関数を差し替えるのは、「出口が log-safe である」こと自体を検査したいから
//      （console.error を直接呼ぶ実装に戻ると、この spy は呼ばれず赤になる）
const mockLogServerError = vi.fn()
vi.mock('@/lib/log-safe', () => ({
  logServerError: (...args: unknown[]) => mockLogServerError(...args),
}))

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

    it('失敗理由を logServerError（伏せ字にする唯一の出口）へ 1 回だけ渡す', async () => {
      // Supabase Auth のエラーは { name, status, code, message } の形。別ブラウザで開いて
      // PKCE の code_verifier が cookie に無いときの flow_state_not_found が最も多い
      const authError = Object.assign(new Error('invalid flow state, no valid flow state found'), {
        name: 'AuthApiError',
        status: 404,
        code: 'flow_state_not_found',
      })
      mockExchangeCodeForSession.mockResolvedValueOnce({ error: authError })
      mockCreateServerClient.mockReturnValue({
        auth: {
          exchangeCodeForSession: mockExchangeCodeForSession,
        },
      })

      const { GET } = await import('@/app/auth/callback/route')
      const request = new NextRequest('http://localhost:3000/auth/callback?code=bad-code')

      const response = await GET(request)

      expect(mockLogServerError).toHaveBeenCalledTimes(1)
      expect(mockLogServerError).toHaveBeenCalledWith('auth_callback_exchange_failed', authError)
      // ログを足しても画面側の挙動（一律のリダイレクト）は変えない
      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toContain('/login?error=auth')
    })
  })

  describe('ログを出さないケース（対照）', () => {
    it('code 交換が成功したときはログを出さない', async () => {
      mockExchangeCodeForSession.mockResolvedValueOnce({ error: null })
      mockCreateServerClient.mockReturnValue({
        auth: {
          exchangeCodeForSession: mockExchangeCodeForSession,
        },
      })

      const { GET } = await import('@/app/auth/callback/route')
      await GET(new NextRequest('http://localhost:3000/auth/callback?code=valid-code'))

      expect(mockLogServerError).not.toHaveBeenCalled()
    })

    it('code が無いときはログを出さない（交換に至っていないので失敗理由が無い）', async () => {
      mockCreateServerClient.mockReturnValue({
        auth: {
          exchangeCodeForSession: mockExchangeCodeForSession,
        },
      })

      const { GET } = await import('@/app/auth/callback/route')
      await GET(new NextRequest('http://localhost:3000/auth/callback'))

      expect(mockLogServerError).not.toHaveBeenCalled()
      expect(mockExchangeCodeForSession).not.toHaveBeenCalled()
    })
  })
})
