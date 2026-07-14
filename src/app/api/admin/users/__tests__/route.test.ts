import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST, DELETE } from '../route'
import { NextRequest } from 'next/server'

const mockListUsers = vi.fn()
const mockInviteUserByEmail = vi.fn()
const mockDeleteUser = vi.fn()
const mockGetUser = vi.fn()
const mockFrom = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabase: () => ({
    auth: {
      admin: {
        listUsers: mockListUsers,
        inviteUserByEmail: mockInviteUserByEmail,
        deleteUser: mockDeleteUser,
      },
    },
    from: mockFrom,
  }),
  createServerSupabase: () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => {
    const result = await mockGetUser()
    const adminEmails = (process.env.ADMIN_EMAILS ?? '')
      .split(',').map((e: string) => e.trim().toLowerCase()).filter(Boolean)
    const email = result?.data?.user?.email?.trim().toLowerCase() ?? ''
    if (!result?.data?.user || !adminEmails.includes(email)) return null
    return result.data.user
  },
}))

const ADMIN_EMAIL = 'admin@test.com'
const ADMIN_ID = 'admin-user-id'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ADMIN_EMAILS = ADMIN_EMAIL
  mockGetUser.mockResolvedValue({
    data: { user: { id: ADMIN_ID, email: ADMIN_EMAIL } },
  })
})

describe('GET /api/admin/users', () => {
  it('ユーザー一覧と担当施設IDを返す（バルク取得）', async () => {
    mockListUsers.mockResolvedValue({
      data: {
        users: [
          { id: 'u1', email: 'a@test.com', last_sign_in_at: '2026-06-27T00:00:00Z' },
          { id: 'u2', email: 'b@test.com', last_sign_in_at: null },
        ],
      },
      error: null,
    })
    const mockIn = vi.fn().mockResolvedValue({
      data: [
        { user_id: 'u1', facility_id: 'f1', role: 'admin' },
        { user_id: 'u1', facility_id: 'f2', role: 'staff' },
      ],
      error: null,
    })
    const mockSelect = vi.fn().mockReturnValue({ in: mockIn })
    mockFrom.mockReturnValue({ select: mockSelect })

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockSelect).toHaveBeenCalledWith('user_id, facility_id, role')
    expect(mockIn).toHaveBeenCalledWith('user_id', ['u1', 'u2'])
    expect(body.users[0].id).toBe('u1')
    expect(body.users[0].facilities).toEqual([
      { id: 'f1', role: 'admin' },
      { id: 'f2', role: 'staff' },
    ])
    expect(body.users[1].facilities).toEqual([])
  })

  it('DBのroleが想定外の値の場合はstaffにフォールバックする', async () => {
    mockListUsers.mockResolvedValue({
      data: { users: [{ id: 'u1', email: 'a@test.com', last_sign_in_at: null }] },
      error: null,
    })
    const mockIn = vi.fn().mockResolvedValue({
      data: [{ user_id: 'u1', facility_id: 'f1', role: 'superadmin' }],
      error: null,
    })
    const mockSelect = vi.fn().mockReturnValue({ in: mockIn })
    mockFrom.mockReturnValue({ select: mockSelect })

    const res = await GET()
    const body = await res.json()

    expect(body.users[0].facilities).toEqual([{ id: 'f1', role: 'staff' }])
  })

  it('非管理者は 403 を返す', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { email: 'other@test.com' } },
    })
    const res = await GET()
    expect(res.status).toBe(403)
  })
})

describe('POST /api/admin/users', () => {
  it('招待メールを送信して 200 を返す', async () => {
    mockInviteUserByEmail.mockResolvedValue({ error: null })
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'new@test.com' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockInviteUserByEmail).toHaveBeenCalledWith('new@test.com')
  })

  it('email 未指定は 400 を返す', async () => {
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/admin/users', () => {
  it('ユーザーを削除して 200 を返す', async () => {
    mockDeleteUser.mockResolvedValue({ error: null })
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'DELETE',
      body: JSON.stringify({ userId: 'u1' }),
    })
    const res = await DELETE(req)
    expect(res.status).toBe(200)
    expect(mockDeleteUser).toHaveBeenCalledWith('u1')
  })

  it('userId 未指定は 400 を返す', async () => {
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'DELETE',
      body: JSON.stringify({}),
    })
    const res = await DELETE(req)
    expect(res.status).toBe(400)
  })

  it('自分自身の削除は 400 を返す', async () => {
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'DELETE',
      body: JSON.stringify({ userId: ADMIN_ID }),
    })
    const res = await DELETE(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('自分自身は削除できません')
  })
})
