import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '../route'

const mockGetUser = vi.fn()
const mockResolveIsAdmin = vi.fn()
const mockCreateDistributorProduct = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/admin-status', () => ({
  resolveIsAdmin: (...args: unknown[]) => mockResolveIsAdmin(...args),
}))

vi.mock('@/lib/distributor-products/repository', () => ({
  listDistributorProducts: vi.fn(),
  createDistributorProduct: (...args: unknown[]) => mockCreateDistributorProduct(...args),
}))

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })
const validInput = { productId: 'p1', maker: 'maker', supplier: 'supplier', name: 'name', categoryId: 'cat1' }

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveIsAdmin.mockResolvedValue(true)
})

describe('POST /api/distributor-products', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validInput) })
    const res = await POST(req as never)
    expect(res.status).toBe(401)
    expect(mockCreateDistributorProduct).not.toHaveBeenCalled()
  })

  it('一般ユーザーの場合は403を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(false)
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validInput) })
    const res = await POST(req as never)
    expect(res.status).toBe(403)
    expect(mockCreateDistributorProduct).not.toHaveBeenCalled()
  })

  it('管理者は正常に作成できる', async () => {
    authenticated()
    mockCreateDistributorProduct.mockResolvedValue({ id: 'dp1', ...validInput })
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validInput) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
  })
})
