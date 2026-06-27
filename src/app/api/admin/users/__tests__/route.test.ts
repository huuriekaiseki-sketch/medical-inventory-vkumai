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

const ADMIN_EMAIL = 'admin@test.com'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ADMIN_EMAILS = ADMIN_EMAIL
  mockGetUser.mockResolvedValue({
    data: { user: { email: ADMIN_EMAIL } },
  })
})

describe('GET /api/admin/users', () => {
  it('ユーザー一覧と担当施設IDを返す', async () => {
    mockListUsers.mockResolvedValue({
      data: {
        users: [
          { id: 'u1', email: 'a@test.com', last_sign_in_at: '2026-06-27T00:00:00Z' },
        ],
      },
      error: null,
    })
    const mockSelect = vi.fn().mockReturnThis()
    const mockEq = vi.fn().mockResolvedValue({
      data: [{ facility_id: 'f1' }],
      error: null,
    })
    mockFrom.mockReturnValue({ select: mockSelect })
    mockSelect.mockReturnValue({ eq: mockEq })

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.users[0].id).toBe('u1')
    expect(body.users[0].facilityIds).toEqual(['f1'])
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
})
