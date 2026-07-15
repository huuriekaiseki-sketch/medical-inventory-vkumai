import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, PUT, DELETE } from '../route'

const mockGetUser = vi.fn()
const mockResolveIsAdmin = vi.fn()
const mockGetDistributorProduct = vi.fn()
const mockUpdateDistributorProduct = vi.fn()
const mockDeleteDistributorProduct = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/admin-status', () => ({
  resolveIsAdmin: (...args: unknown[]) => mockResolveIsAdmin(...args),
}))

vi.mock('@/lib/distributor-products/repository', () => ({
  getDistributorProduct: (...args: unknown[]) => mockGetDistributorProduct(...args),
  updateDistributorProduct: (...args: unknown[]) => mockUpdateDistributorProduct(...args),
  deleteDistributorProduct: (...args: unknown[]) => mockDeleteDistributorProduct(...args),
}))

const context = { params: Promise.resolve({ id: 'dp1' }) }
const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

const validInput = { productId: 'p1', maker: 'maker', supplier: 'supplier', name: 'name', categoryId: 'cat1' }

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveIsAdmin.mockResolvedValue(true)
})

describe('GET /api/distributor-products/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(401)
    expect(mockGetDistributorProduct).not.toHaveBeenCalled()
  })

  it('認証済みで正常に取得できる', async () => {
    authenticated()
    mockGetDistributorProduct.mockResolvedValue({ id: 'dp1', ...validInput })
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(200)
  })
})

describe('PUT /api/distributor-products/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify(validInput) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(401)
    expect(mockUpdateDistributorProduct).not.toHaveBeenCalled()
  })

  it('認証済みで正常に更新できる', async () => {
    authenticated()
    mockUpdateDistributorProduct.mockResolvedValue({ id: 'dp1', ...validInput })
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify(validInput) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(200)
  })

  it('一般ユーザーの場合は403を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(false)
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify(validInput) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(403)
    expect(mockUpdateDistributorProduct).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/distributor-products/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await DELETE(new Request('http://localhost') as never, context)
    expect(res.status).toBe(401)
    expect(mockDeleteDistributorProduct).not.toHaveBeenCalled()
  })

  it('認証済みで正常に削除できる', async () => {
    authenticated()
    mockDeleteDistributorProduct.mockResolvedValue(undefined)
    const res = await DELETE(new Request('http://localhost') as never, context)
    expect(res.status).toBe(200)
  })

  it('一般ユーザーの場合は403を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(false)
    const res = await DELETE(new Request('http://localhost') as never, context)
    expect(res.status).toBe(403)
    expect(mockDeleteDistributorProduct).not.toHaveBeenCalled()
  })
})
