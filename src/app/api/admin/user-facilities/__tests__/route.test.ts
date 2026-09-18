import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST, DELETE } from '../route'
import { NextRequest } from 'next/server'

const mockGetUser = vi.fn()
const mockFrom = vi.fn()

const mockUpsert = vi.fn()

// WHY(2026-09-07、P-035): 所属と役割の書き込みは service_role をやめて利用者の JWT に移した。
//      RLS の `is_admin() AND has_aal2()` が書き込みと同じ文で評価されるようにするため。
//      モックの入口も createServerSupabase に寄せる。
vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
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
    mockUpsert.mockReturnValue({ select: () => Promise.resolve({ data: [{ user_id: 'u1' }], error: null }) })

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
    mockUpsert.mockReturnValue({ select: () => Promise.resolve({ data: [{ user_id: 'u1' }], error: null }) })

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
    mockUpsert.mockReturnValue({ select: () => Promise.resolve({ data: [{ user_id: 'u1' }], error: null }) })

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
    mockUpsert.mockReturnValue({ select: () => Promise.resolve({ data: [{ user_id: 'u1' }], error: null }) })

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

  // WHY(0 行を成功にしない): RLS に弾かれた書き込みは error を返さず、単に 0 行になる。
  //      そのまま 200 を返すと「成功したのに何も起きていない」になる。
  //      aal2 へ昇格していない admin がここに来る（P-035）。
  it('RLS に弾かれて 0 行のときは 200 ではなく 403 を返す', async () => {
    mockFrom.mockReturnValue({ upsert: mockUpsert })
    mockUpsert.mockReturnValue({ select: () => Promise.resolve({ data: [], error: null }) })

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
    const mockEq2 = vi
      .fn()
      .mockReturnValue({ select: () => Promise.resolve({ data: [{ user_id: 'u1' }], error: null }) })
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

  it('RLS に弾かれて 0 行のときは 200 ではなく 403 を返す', async () => {
    const mockEq2 = vi.fn().mockReturnValue({ select: () => Promise.resolve({ data: [], error: null }) })
    const mockEq1 = vi.fn().mockReturnValue({ eq: mockEq2 })
    mockFrom.mockReturnValue({ delete: vi.fn().mockReturnValue({ eq: mockEq1 }) })

    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'DELETE',
      body: JSON.stringify({ userId: 'u1', facilityId: 'f1' }),
    })
    const res = await DELETE(req)
    expect(res.status).toBe(403)
  })
})
