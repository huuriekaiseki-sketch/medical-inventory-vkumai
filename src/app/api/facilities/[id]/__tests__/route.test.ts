import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, PUT, DELETE } from '../route'

const mockGetUser = vi.fn()
const mockResolveIsAdmin = vi.fn()
const mockGetFacility = vi.fn()
const mockUpdateFacility = vi.fn()
const mockDeleteFacility = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/admin-status', () => ({
  resolveIsAdmin: (...args: unknown[]) => mockResolveIsAdmin(...args),
}))

vi.mock('@/lib/facilities/repository', () => ({
  getFacility: (...args: unknown[]) => mockGetFacility(...args),
  updateFacility: (...args: unknown[]) => mockUpdateFacility(...args),
  deleteFacility: (...args: unknown[]) => mockDeleteFacility(...args),
}))

const context = { params: Promise.resolve({ id: 'f1' }) }
const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveIsAdmin.mockResolvedValue(true)
})

describe('GET /api/facilities/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(401)
    expect(mockGetFacility).not.toHaveBeenCalled()
  })

  it('認証済みで正常に取得できる', async () => {
    authenticated()
    mockGetFacility.mockResolvedValue({ id: 'f1', name: '施設A' })
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(200)
  })
})

describe('PUT /api/facilities/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ name: 'x' }) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(401)
    expect(mockUpdateFacility).not.toHaveBeenCalled()
  })

  it('認証済みで正常に更新できる', async () => {
    authenticated()
    mockUpdateFacility.mockResolvedValue({ id: 'f1', name: 'x' })
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ name: 'x' }) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(200)
  })

  it('一般ユーザーの場合は403を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(false)
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ name: 'x' }) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(403)
    expect(mockUpdateFacility).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/facilities/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await DELETE(new Request('http://localhost') as never, context)
    expect(res.status).toBe(401)
    expect(mockDeleteFacility).not.toHaveBeenCalled()
  })

  it('認証済みで正常に削除できる', async () => {
    authenticated()
    mockDeleteFacility.mockResolvedValue(undefined)
    const res = await DELETE(new Request('http://localhost') as never, context)
    expect(res.status).toBe(200)
  })

  it('一般ユーザーの場合は403を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(false)
    const res = await DELETE(new Request('http://localhost') as never, context)
    expect(res.status).toBe(403)
    expect(mockDeleteFacility).not.toHaveBeenCalled()
  })
})
