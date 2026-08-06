import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '../route'

const mockGetUser = vi.fn()
const mockResolveIsAdmin = vi.fn()
const mockGetUserFacilityRole = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/admin-status', () => ({
  resolveIsAdmin: (...args: unknown[]) => mockResolveIsAdmin(...args),
}))

vi.mock('@/lib/user-facilities/repository', () => ({
  getUserFacilityRole: (...args: unknown[]) => mockGetUserFacilityRole(...args),
}))

const context = { params: Promise.resolve({ id: 'f1' }) }
const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveIsAdmin.mockResolvedValue(false)
})

describe('GET /api/facilities/[id]/my-role', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(401)
    expect(mockGetUserFacilityRole).not.toHaveBeenCalled()
  })

  it('adminの場合はuser_facilitiesを問い合わせずadminを返す(施設に行がなくても全施設を操作できるため)', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    const res = await GET(new Request('http://localhost') as never, context)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ role: 'admin' })
    expect(mockGetUserFacilityRole).not.toHaveBeenCalled()
  })

  it('staffの場合はstaffを返す', async () => {
    authenticated()
    mockGetUserFacilityRole.mockResolvedValue('staff')
    const res = await GET(new Request('http://localhost') as never, context)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ role: 'staff' })
  })

  it('viewerの場合はviewerを返す(issue #608)', async () => {
    authenticated()
    mockGetUserFacilityRole.mockResolvedValue('viewer')
    const res = await GET(new Request('http://localhost') as never, context)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ role: 'viewer' })
  })

  it('未所属の場合はnullを返す', async () => {
    authenticated()
    mockGetUserFacilityRole.mockResolvedValue(null)
    const res = await GET(new Request('http://localhost') as never, context)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ role: null })
  })
})
