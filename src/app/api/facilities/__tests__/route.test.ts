import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST } from '../route'

const mockGetUser = vi.fn()
const mockResolveIsAdmin = vi.fn()
const mockListFacilities = vi.fn()
const mockCreateFacility = vi.fn()
const mockListUserFacilities = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/admin-status', () => ({
  resolveIsAdmin: (...args: unknown[]) => mockResolveIsAdmin(...args),
}))

vi.mock('@/lib/facilities/repository', () => ({
  listFacilities: (...args: unknown[]) => mockListFacilities(...args),
  createFacility: (...args: unknown[]) => mockCreateFacility(...args),
}))

vi.mock('@/lib/user-facilities/repository', () => ({
  listUserFacilities: (...args: unknown[]) => mockListUserFacilities(...args),
}))

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })
const validInput = { name: '施設A' }

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveIsAdmin.mockResolvedValue(true)
  mockListFacilities.mockResolvedValue([])
  mockListUserFacilities.mockResolvedValue([])
})

describe('GET /api/facilities', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('施設一覧とfacilityId別roleを返す(issue #608)', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(false)
    mockListFacilities.mockResolvedValue([{ id: 'f1', name: '施設A' }, { id: 'f2', name: '施設B' }])
    mockListUserFacilities.mockResolvedValue([
      { facilityId: 'f1', facilityName: '施設A', role: 'viewer' },
      { facilityId: 'f2', facilityName: '施設B', role: 'staff' },
    ])
    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.isAdmin).toBe(false)
    expect(body.roleByFacilityId).toEqual({ f1: 'viewer', f2: 'staff' })
  })
})

describe('POST /api/facilities', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validInput) })
    const res = await POST(req as never)
    expect(res.status).toBe(401)
    expect(mockCreateFacility).not.toHaveBeenCalled()
  })

  it('一般ユーザーの場合は403を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(false)
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validInput) })
    const res = await POST(req as never)
    expect(res.status).toBe(403)
    expect(mockCreateFacility).not.toHaveBeenCalled()
  })

  it('管理者は正常に作成できる', async () => {
    authenticated()
    mockCreateFacility.mockResolvedValue({ id: 'f1', ...validInput })
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validInput) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
  })
})
