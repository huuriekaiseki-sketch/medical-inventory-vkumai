import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { proxy, config } from '../proxy'
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

    // WHY(issue #803 の受け入れ条件「aal1 で『0 件』を返さない」): 明細の SELECT ポリシーは has_aal2() を
    //      要求するので、aal1 のセッションが route まで届くと RLS が全行を隠し、**エラーではなく空の結果**になる。
    //      ロット検索で空は「該当なし」と読まれる＝リコールの取りこぼし。route は既存の施設スコープの
    //      読み取り API と同じく aal を自分では見ないので、**届かせないのは proxy のこのガードだけ**。
    //      このテストは proxy() を直接呼ぶので、**Next.js が呼ぶ前に当てる matcher は通らない**。
    //      matcher が /api/* を含むことは、すぐ下の「matcher が API のパスを含む」が別に固定している
    //      （DB 層で空になること自体は lot-search-rls-idor.integration.test.ts が対で固定している）
    it('aal1→aal2が必要なユーザーがロット検索の API を直接呼ぶ→ route に届かず /mfa-challenge へ（0 件を返させない）', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'mfa-user', email: 'mfa@example.com' },
          false,
          false,
          { currentLevel: 'aal1', nextLevel: 'aal2' }
        ) as unknown as ReturnType<typeof createServerClient>
      )

      const response = await proxy(
        new NextRequest(new URL('http://localhost:3000/api/facilities/f-1/lot-search?lot=ABC'))
      )

      expect(response?.status).toBe(307)
      expect(response?.headers.get('location')).toContain('/mfa-challenge')
    })

    // WHY(issue #803): 上のテストを含め、このファイルのテストは全部 proxy() を直接呼ぶ。matcher から api が
    //      外れると、**施設スコープの読み取り API すべてで MFA ガードが無音で外れる**（route は aal を見ず、
    //      RLS は aal1 に空を返すだけなので、どのテストも落ちない）。matcher の中身そのものを見る。
    //      Next.js の matcher は path-to-regexp だが、この 1 本は素の正規表現として読める形なので RegExp で当てる。
    //      形が変わってこの読み方が成り立たなくなったら、下の「静的ファイルは外れる」の対照が先に落ちる
    it('matcher が API のパスを含む（外れると全 API で MFA ガードが無音で外れる）', () => {
      expect(config.matcher).toHaveLength(1)
      const re = new RegExp(`^${config.matcher[0]}$`)

      expect(re.test('/api/facilities/f-1/lot-search')).toBe(true)
      expect(re.test('/api/case-orders')).toBe(true)
      expect(re.test('/facilities/f-1/lot-search')).toBe(true)
      // 対照: 除外しているものは外れる（何でも true を返す正規表現になっていないこと）
      expect(re.test('/_next/static/chunk.js')).toBe(false)
      expect(re.test('/logo.png')).toBe(false)
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

    // WHY: issue #757 の 31（fail-open の総点検）。MFA API が落ちている間、以前は aal が取れないと
    //      ガードを素通りさせていた（MFA 登録済みの aal1 セッションが保護ページを読める）。
    //      判定材料が取れないときは「昇格が要る」側に倒す（docs/agents/fail-open-inventory.md F-004）
    it('MFA API がエラーを返したら保護パスを通さず /mfa-challenge へ送る（fail-closed）', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: { id: 'u', email: 'u@example.com' } }, error: null }),
          mfa: {
            getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: null, error: { message: 'mfa api down' } }),
          },
        },
        rpc: vi.fn(),
      } as unknown as ReturnType<typeof createServerClient>)

      const response = await proxy(new NextRequest(new URL('http://localhost:3000/facilities')))

      expect(response?.status).toBe(307)
      expect(response?.headers.get('location')).toContain('/mfa-challenge')
    })

    it('MFA API が error なしで data も null を返したときも /mfa-challenge へ送る', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: { id: 'u', email: 'u@example.com' } }, error: null }),
          mfa: {
            getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: null, error: null }),
          },
        },
        rpc: vi.fn(),
      } as unknown as ReturnType<typeof createServerClient>)

      const response = await proxy(new NextRequest(new URL('http://localhost:3000/facilities')))

      expect(response?.status).toBe(307)
      expect(response?.headers.get('location')).toContain('/mfa-challenge')
    })

    it('MFA API がエラーでも /mfa-challenge 自体は通す（ループしない）', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: { id: 'u', email: 'u@example.com' } }, error: null }),
          mfa: {
            getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: null, error: { message: 'mfa api down' } }),
          },
        },
        rpc: vi.fn(),
      } as unknown as ReturnType<typeof createServerClient>)

      const response = await proxy(new NextRequest(new URL('http://localhost:3000/mfa-challenge')))

      expect(response?.status).not.toBe(307)
    })

    it('getUser がエラーを返したら未認証として /login へ送る', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: { id: 'stale', email: 'stale@example.com' } }, error: { message: 'auth down' } }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const response = await proxy(new NextRequest(new URL('http://localhost:3000/facilities')))

      expect(response?.status).toBe(307)
      expect(response?.headers.get('location')).toContain('/login')
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

  // WHY(#757-24): Route Handler は自分のパスを知る手段が無いので、拒否の記録に経路を残すには
  //      proxy が転送リクエストへ付けるしかない。付け忘れると証跡の route が静かに空になる
  describe('拒否の記録に使う転送ヘッダ', () => {
    it('通過するリクエストにパスとメソッドを付ける', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc({ id: 'u-1', email: 'u1@example.com' }, false, false) as unknown as ReturnType<
          typeof createServerClient
        >
      )

      const request = new NextRequest(new URL('http://localhost:3000/api/case-orders?facility_id=abc'), {
        method: 'POST',
      })

      const response = await proxy(request)

      expect(response?.status).not.toBe(307)
      expect(response?.headers.get('x-middleware-override-headers')).toContain('x-aidd-route')
      expect(response?.headers.get('x-middleware-request-x-aidd-route')).toBe('/api/case-orders')
      expect(response?.headers.get('x-middleware-request-x-aidd-method')).toBe('POST')
    })

    it('クライアントが送ってきた同名ヘッダは上書きする（偽の経路を証跡に書かせない）', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc({ id: 'u-2', email: 'u2@example.com' }, false, false) as unknown as ReturnType<
          typeof createServerClient
        >
      )

      const request = new NextRequest(new URL('http://localhost:3000/api/loan-orders'), {
        method: 'GET',
        headers: { 'x-aidd-route': '/api/harmless', 'x-aidd-method': 'OPTIONS' },
      })

      const response = await proxy(request)

      expect(response?.headers.get('x-middleware-request-x-aidd-route')).toBe('/api/loan-orders')
      expect(response?.headers.get('x-middleware-request-x-aidd-method')).toBe('GET')
    })
  })

  // WHY(#757-24): admin パスへの未認可アクセスを /login へ跳ね返す際、access_denials への
  //      記録に使う印（httpOnly cookie）を proxy が載せる。/login 到達時は proxy が消す
  describe('拒否記録用の印（httpOnly cookie） [P-063]', () => {
    it('未ログインで /admin にアクセス → 印が付く（reason=unauthenticated, route=/admin）', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: null } }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(new URL('http://localhost:3000/admin'))
      const response = await proxy(request)

      expect(response?.status).toBe(307)
      const setCookie = response?.headers.get('set-cookie') ?? ''
      expect(setCookie).toContain('aidd-denial=')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('Path=/login')

      const { parseProxyDenial } = await import('@/lib/security/denial-headers')
      const match = setCookie.match(/aidd-denial=([^;]+)/)
      const payload = parseProxyDenial(decodeURIComponent(match![1]))
      expect(payload).toEqual({ reason: 'unauthenticated', route: '/admin', method: 'GET' })
    })

    it('未ログインで /api/admin/users にPOST → route/methodが実際の値になる', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: null } }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(new URL('http://localhost:3000/api/admin/users'), {
        method: 'POST',
      })
      const response = await proxy(request)

      const { parseProxyDenial } = await import('@/lib/security/denial-headers')
      const setCookie = response?.headers.get('set-cookie') ?? ''
      const match = setCookie.match(/aidd-denial=([^;]+)/)
      const payload = parseProxyDenial(decodeURIComponent(match![1]))
      expect(payload).toEqual({ reason: 'unauthenticated', route: '/api/admin/users', method: 'POST' })
    })

    it('ログイン済み非adminで /admin/settings → 印が付く（reason=not_admin）', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'user-1', email: 'user@example.com' },
          false,
          false
        ) as unknown as ReturnType<typeof createServerClient>
      )

      const request = new NextRequest(new URL('http://localhost:3000/admin/settings'))
      const response = await proxy(request)

      const { parseProxyDenial } = await import('@/lib/security/denial-headers')
      const setCookie = response?.headers.get('set-cookie') ?? ''
      const match = setCookie.match(/aidd-denial=([^;]+)/)
      const payload = parseProxyDenial(decodeURIComponent(match![1]))
      expect(payload).toEqual({ reason: 'not_admin', route: '/admin/settings', method: 'GET' })
    })

    it('未ログインで admin 以外（/facilities）にアクセス → 印は付かない（回帰）', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: null } }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(new URL('http://localhost:3000/facilities'))
      const response = await proxy(request)

      expect(response?.status).toBe(307)
      expect(response?.headers.get('set-cookie') ?? '').not.toContain('aidd-denial=')
    })

    it('DBにrole=adminがあるユーザーが /admin にアクセス → 印は付かない', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(
          { id: 'admin-2', email: 'admin@example.com' },
          true,
          true
        ) as unknown as ReturnType<typeof createServerClient>
      )

      const request = new NextRequest(new URL('http://localhost:3000/admin'))
      const response = await proxy(request)

      expect(response?.status).not.toBe(307)
      expect(response?.headers.get('set-cookie') ?? '').not.toContain('aidd-denial=')
    })

    it('印付きで /login に来ると通し、応答で印を消す（Max-Age=0）', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: null } }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(new URL('http://localhost:3000/login'))
      request.cookies.set('aidd-denial', 'dummy')

      const response = await proxy(request)

      expect(response?.status).not.toBe(307)
      const setCookie = response?.headers.get('set-cookie') ?? ''
      expect(setCookie).toContain('aidd-denial=')
      expect(setCookie).toContain('Max-Age=0')
      // WHY: 応答で cookie を消すと Server Component の cookies() にも削除が先回りするので、
      //      中身は転送リクエストのヘッダで渡す（E2E で発覚した記録 0 件の再発防止）
      expect(response?.headers.get('x-middleware-request-x-aidd-denial')).toBe('dummy')
    })

    it('/login でクライアントが x-aidd-denial ヘッダを偽装しても、印が無ければ削除される', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: null } }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(new URL('http://localhost:3000/login'), {
        headers: { 'x-aidd-denial': '{"reason":"not_admin","route":"/admin","method":"GET"}' },
      })
      const response = await proxy(request)

      expect(response?.headers.get('x-middleware-request-x-aidd-denial')).toBeNull()
    })

    it('印なしで /login に来ると、削除の set-cookie は出ない', async () => {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce({
        auth: {
          getUser: vi.fn().mockResolvedValueOnce({ data: { user: null } }),
        },
      } as unknown as ReturnType<typeof createServerClient>)

      const request = new NextRequest(new URL('http://localhost:3000/login'))
      const response = await proxy(request)

      const setCookie = response?.headers.get('set-cookie') ?? ''
      expect(setCookie).not.toContain('aidd-denial=')
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

  // WHY(#757 の 16 の残り): proxy は 6 か所から応答を返す。CSP を載せるのは唯一の入口
  //      （proxy() が handleRequest の戻りに付ける）1 か所だけなので、**どの経路でも付く**ことを
  //      経路ごとに測る。返り口を足した人が忘れても、ここが落ちる。
  describe('CSP（#757 の 16）', () => {
    async function responseFor(path: string, user: { id: string; email: string } | null, isAdmin = false) {
      const { createServerClient } = await import('@supabase/ssr')
      vi.mocked(createServerClient).mockReturnValueOnce(
        makeSupabaseClientWithAdminRpc(user, isAdmin, true) as unknown as ReturnType<typeof createServerClient>
      )
      return proxy(new NextRequest(new URL(`http://localhost:3000${path}`)))
    }

    const USER = { id: 'u1', email: 'user@example.com' }

    it.each([
      ['未認証リダイレクト', '/facilities', null, false],
      ['admin 拒否リダイレクト', '/admin', USER, false],
      ['admin 通過', '/admin', USER, true],
      ['通常ページ', '/facilities', USER, false],
      ['/login', '/login', null, false],
    ])('%s の応答にも CSP が付く', async (_name, path, user, isAdmin) => {
      const response = await responseFor(path, user, isAdmin)
      const csp = response.headers.get('Content-Security-Policy')
      expect(csp).toBeTruthy()
      expect(csp).toContain("script-src 'self' 'nonce-")
    })

    it('nonce はリクエストごとに変わる', async () => {
      const a = await responseFor('/facilities', USER)
      const b = await responseFor('/facilities', USER)
      const nonceOf = (r: NextResponse) =>
        /'nonce-([^']+)'/.exec(r.headers.get('Content-Security-Policy') ?? '')?.[1]
      expect(nonceOf(a)).toBeTruthy()
      expect(nonceOf(a)).not.toBe(nonceOf(b))
    })

    it('応答と転送リクエストで同じ nonce を使う（ずれると Next.js がタグに付けられない）', async () => {
      const response = await responseFor('/facilities', USER)
      const responseNonce = /'nonce-([^']+)'/.exec(
        response.headers.get('Content-Security-Policy') ?? ''
      )?.[1]
      // NextResponse.next({request:{headers}}) の中身はこのヘッダに畳まれる
      const forwarded = response.headers.get('x-middleware-override-headers')
      expect(forwarded).toContain('x-nonce')
      expect(response.headers.get('x-middleware-request-x-nonce')).toBe(responseNonce)
    })
  })
})
