import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { encodeProxyDenial } from '@/lib/security/denial-headers'

// WHY(#757-24): page.tsx は async Server Component。await LoginPage() で返る JSX を
//      render() に渡すことで、Next.js のフルランタイムなしに検証する

// WHY: proxy が印の cookie の中身を x-aidd-denial ヘッダに載せ替えて渡す（cookie は応答で
//      消され、cookies() には削除が先回りするため）。page は headers() を読む
const mockHeaderGet = vi.fn()
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve({ get: mockHeaderGet })),
}))
// 既存テストの記述を保つための薄い変換: { value } → ヘッダの文字列
const mockCookieGet = {
  mockReturnValue(v: { value: string } | undefined) {
    mockHeaderGet.mockReturnValue(v?.value ?? null)
  },
}

const mockRecordAccessDenial = vi.fn()
vi.mock('@/lib/security/access-denial', () => ({
  recordAccessDenial: (...args: unknown[]) => mockRecordAccessDenial(...args),
}))

const mockGetUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: vi.fn(() => Promise.resolve({ auth: { getUser: mockGetUser } })),
}))

vi.mock('../LoginForm', () => ({
  default: () => <div>login-form</div>,
}))

vi.mock('@/lib/log-safe', () => ({
  logServerError: vi.fn(),
}))

describe('LoginPage(Server Component) — proxy の admin 拒否を記録する [P-063]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCookieGet.mockReturnValue(undefined)
  })

  it('印が無ければ recordAccessDenial は呼ばれず、LoginForm を描画する', async () => {
    const LoginPage = (await import('../page')).default
    const jsx = await LoginPage()
    render(jsx)

    expect(screen.getByText('login-form')).toBeInTheDocument()
    expect(mockRecordAccessDenial).not.toHaveBeenCalled()
  })

  it('印がunauthenticatedなら guard=proxy_admin, actorId無しで記録する', async () => {
    mockCookieGet.mockReturnValue({
      value: encodeProxyDenial({ reason: 'unauthenticated', route: '/admin', method: 'GET' }),
    })

    const LoginPage = (await import('../page')).default
    const jsx = await LoginPage()
    render(jsx)

    expect(mockRecordAccessDenial).toHaveBeenCalledWith({
      guard: 'proxy_admin',
      reason: 'unauthenticated',
      route: '/admin',
      method: 'GET',
      actorId: undefined,
    })
    expect(mockGetUser).not.toHaveBeenCalled()
    expect(screen.getByText('login-form')).toBeInTheDocument()
  })

  it('印がnot_adminならセッションからactorIdを取って記録する', async () => {
    mockCookieGet.mockReturnValue({
      value: encodeProxyDenial({ reason: 'not_admin', route: '/admin/settings', method: 'GET' }),
    })
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })

    const LoginPage = (await import('../page')).default
    const jsx = await LoginPage()
    render(jsx)

    expect(mockRecordAccessDenial).toHaveBeenCalledWith({
      guard: 'proxy_admin',
      reason: 'not_admin',
      route: '/admin/settings',
      method: 'GET',
      actorId: 'user-123',
    })
  })

  it('印が壊れている（JSONでない）場合は記録されず、LoginFormは描画される', async () => {
    mockCookieGet.mockReturnValue({ value: 'not-json' })

    const LoginPage = (await import('../page')).default
    const jsx = await LoginPage()
    render(jsx)

    expect(mockRecordAccessDenial).not.toHaveBeenCalled()
    expect(screen.getByText('login-form')).toBeInTheDocument()
  })

  it('印のrouteが201文字の場合は記録されない', async () => {
    mockCookieGet.mockReturnValue({
      value: JSON.stringify({ reason: 'unauthenticated', route: '/' + 'a'.repeat(200), method: 'GET' }),
    })

    const LoginPage = (await import('../page')).default
    const jsx = await LoginPage()
    render(jsx)

    expect(mockRecordAccessDenial).not.toHaveBeenCalled()
  })

  it('recordAccessDenialがthrowしてもLoginFormは描画される', async () => {
    mockCookieGet.mockReturnValue({
      value: encodeProxyDenial({ reason: 'unauthenticated', route: '/admin', method: 'GET' }),
    })
    mockRecordAccessDenial.mockRejectedValue(new Error('db down'))

    const LoginPage = (await import('../page')).default
    const jsx = await LoginPage()
    render(jsx)

    expect(screen.getByText('login-form')).toBeInTheDocument()
  })

  it('not_adminでgetUserが失敗しても記録をスキップしLoginFormは描画される', async () => {
    mockCookieGet.mockReturnValue({
      value: encodeProxyDenial({ reason: 'not_admin', route: '/admin', method: 'GET' }),
    })
    mockGetUser.mockRejectedValue(new Error('session error'))

    const LoginPage = (await import('../page')).default
    const jsx = await LoginPage()
    render(jsx)

    expect(mockRecordAccessDenial).not.toHaveBeenCalled()
    expect(screen.getByText('login-form')).toBeInTheDocument()
  })
})
