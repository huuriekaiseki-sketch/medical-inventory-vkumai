import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { DELETE } from '../route'

const mockGetUser = vi.fn()
const mockResolveIsAdmin = vi.fn()
const mockDeleteCompatibility = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/admin-status', () => ({
  resolveIsAdmin: (...args: unknown[]) => mockResolveIsAdmin(...args),
}))

vi.mock('@/lib/compatibilities/repository', () => ({
  deleteCompatibility: (...args: unknown[]) => mockDeleteCompatibility(...args),
}))

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

const COMPAT_ID_1 = '11111111-1111-1111-1111-111111111111'
const COMPAT_ID_2 = '22222222-2222-2222-2222-222222222222'

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DELETE /api/compat/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await DELETE(new NextRequest(`http://localhost/api/compat/${COMPAT_ID_1}`), makeContext(COMPAT_ID_1))
    expect(res.status).toBe(401)
    expect(mockDeleteCompatibility).not.toHaveBeenCalled()
  })

  it('一般ユーザーの場合は403を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(false)
    const res = await DELETE(new NextRequest(`http://localhost/api/compat/${COMPAT_ID_1}`), makeContext(COMPAT_ID_1))
    expect(res.status).toBe(403)
    expect(mockDeleteCompatibility).not.toHaveBeenCalled()
  })

  it('不正な形式のIDの場合は400を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    const res = await DELETE(new NextRequest('http://localhost/api/compat/not-a-uuid'), makeContext('not-a-uuid'))
    expect(res.status).toBe(400)
    expect(mockDeleteCompatibility).not.toHaveBeenCalled()
  })

  it('存在しないIDの場合は404を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    mockDeleteCompatibility.mockResolvedValue(false)
    const res = await DELETE(new NextRequest(`http://localhost/api/compat/${COMPAT_ID_2}`), makeContext(COMPAT_ID_2))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('すでに削除されています')
  })

  it('管理者が存在するIDを削除すると200を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    mockDeleteCompatibility.mockResolvedValue(true)
    const res = await DELETE(new NextRequest(`http://localhost/api/compat/${COMPAT_ID_1}`), makeContext(COMPAT_ID_1))
    expect(res.status).toBe(200)
    expect(mockDeleteCompatibility).toHaveBeenCalledWith(expect.anything(), COMPAT_ID_1)
  })
})
