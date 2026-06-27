import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST, DELETE } from '../route'
import { NextRequest } from 'next/server'

const mockInsert = vi.fn()
const mockDelete = vi.fn()
const mockGetUser = vi.fn()
const mockFrom = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabase: () => ({ from: mockFrom }),
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

describe('POST /api/admin/user-facilities', () => {
  it('施設を割り当てて 200 を返す', async () => {
    mockFrom.mockReturnValue({ insert: mockInsert })
    mockInsert.mockResolvedValue({ error: null })

    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'POST',
      body: JSON.stringify({ userId: 'u1', facilityId: 'f1' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockInsert).toHaveBeenCalledWith({ user_id: 'u1', facility_id: 'f1' })
  })

  it('非管理者は 403 を返す', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { email: 'other@test.com' } },
    })
    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'POST',
      body: JSON.stringify({ userId: 'u1', facilityId: 'f1' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(403)
  })
})

describe('DELETE /api/admin/user-facilities', () => {
  it('施設割り当てを削除して 200 を返す', async () => {
    const mockEq1 = vi.fn().mockReturnThis()
    const mockEq2 = vi.fn().mockResolvedValue({ error: null })
    mockFrom.mockReturnValue({ delete: mockDelete })
    mockDelete.mockReturnValue({ eq: mockEq1 })
    mockEq1.mockReturnValue({ eq: mockEq2 })

    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'DELETE',
      body: JSON.stringify({ userId: 'u1', facilityId: 'f1' }),
    })
    const res = await DELETE(req)
    expect(res.status).toBe(200)
  })
})
