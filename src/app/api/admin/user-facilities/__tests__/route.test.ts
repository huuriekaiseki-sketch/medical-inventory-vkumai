import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST, DELETE } from '../route'
import { NextRequest } from 'next/server'

const mockGetUser = vi.fn()
const mockFrom = vi.fn()

const mockUpsert = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabase: () => ({ from: mockFrom }),
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

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ADMIN_EMAILS = ADMIN_EMAIL
  mockGetUser.mockResolvedValue({
    data: { user: { email: ADMIN_EMAIL } },
  })
})

describe('POST /api/admin/user-facilities', () => {
  it('role 省略時は staff で upsert して 200 を返す', async () => {
    mockFrom.mockReturnValue({ upsert: mockUpsert })
    mockUpsert.mockResolvedValue({ error: null })

    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'POST',
      body: JSON.stringify({ userId: 'u1', facilityId: 'f1' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockUpsert).toHaveBeenCalledWith(
      { user_id: 'u1', facility_id: 'f1', role: 'staff' },
      { onConflict: 'user_id,facility_id' }
    )
  })

  it('role=admin で upsert して 200 を返す', async () => {
    mockFrom.mockReturnValue({ upsert: mockUpsert })
    mockUpsert.mockResolvedValue({ error: null })

    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'POST',
      body: JSON.stringify({ userId: 'u1', facilityId: 'f1', role: 'admin' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockUpsert).toHaveBeenCalledWith(
      { user_id: 'u1', facility_id: 'f1', role: 'admin' },
      { onConflict: 'user_id,facility_id' }
    )
  })

  it('role=viewer で upsert して 200 を返す', async () => {
    mockFrom.mockReturnValue({ upsert: mockUpsert })
    mockUpsert.mockResolvedValue({ error: null })

    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'POST',
      body: JSON.stringify({ userId: 'u1', facilityId: 'f1', role: 'viewer' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockUpsert).toHaveBeenCalledWith(
      { user_id: 'u1', facility_id: 'f1', role: 'viewer' },
      { onConflict: 'user_id,facility_id' }
    )
  })

  it('既存レコードの role を staff から admin に更新できる', async () => {
    mockFrom.mockReturnValue({ upsert: mockUpsert })
    mockUpsert.mockResolvedValue({ error: null })

    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'POST',
      body: JSON.stringify({ userId: 'u1', facilityId: 'f1', role: 'admin' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockUpsert).toHaveBeenCalledWith(
      { user_id: 'u1', facility_id: 'f1', role: 'admin' },
      { onConflict: 'user_id,facility_id' }
    )
  })

  it('role=invalid は 400 を返す', async () => {
    mockFrom.mockReturnValue({ upsert: mockUpsert })
    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'POST',
      body: JSON.stringify({ userId: 'u1', facilityId: 'f1', role: 'invalid' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect(mockUpsert).not.toHaveBeenCalled()
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

  it('userId 未指定は 400 を返す', async () => {
    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'POST',
      body: JSON.stringify({ facilityId: 'f1' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/admin/user-facilities', () => {
  it('施設割り当てを削除して 200 を返す', async () => {
    const mockEq2 = vi.fn().mockResolvedValue({ error: null })
    const mockEq1 = vi.fn().mockReturnValue({ eq: mockEq2 })
    const mockDel = vi.fn().mockReturnValue({ eq: mockEq1 })
    mockFrom.mockReturnValue({ delete: mockDel })

    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'DELETE',
      body: JSON.stringify({ userId: 'u1', facilityId: 'f1' }),
    })
    const res = await DELETE(req)
    expect(res.status).toBe(200)
    expect(mockDel).toHaveBeenCalled()
    expect(mockEq1).toHaveBeenCalledWith('user_id', 'u1')
    expect(mockEq2).toHaveBeenCalledWith('facility_id', 'f1')
  })

  it('userId 未指定は 400 を返す', async () => {
    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'DELETE',
      body: JSON.stringify({ facilityId: 'f1' }),
    })
    const res = await DELETE(req)
    expect(res.status).toBe(400)
  })

  it('非管理者は 403 を返す', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { email: 'other@test.com' } },
    })
    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'DELETE',
      body: JSON.stringify({ userId: 'u1', facilityId: 'f1' }),
    })
    const res = await DELETE(req)
    expect(res.status).toBe(403)
  })
})
