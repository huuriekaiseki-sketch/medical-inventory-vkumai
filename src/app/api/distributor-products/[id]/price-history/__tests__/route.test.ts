import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '../route'

const mockGetUser = vi.fn()
const mockGetDistributorProduct = vi.fn()
const mockGetPriceHistory = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/distributor-products/repository', () => ({
  getDistributorProduct: (...args: unknown[]) => mockGetDistributorProduct(...args),
}))

vi.mock('@/lib/price-histories/repository', () => ({
  getPriceHistory: (...args: unknown[]) => mockGetPriceHistory(...args),
}))

const params = Promise.resolve({ id: 'dp1' })
const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/distributor-products/[id]/price-history', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new Request('http://localhost') as never, { params })
    expect(res.status).toBe(401)
    expect(mockGetDistributorProduct).not.toHaveBeenCalled()
  })

  it('認証済みで正常に取得できる', async () => {
    authenticated()
    mockGetDistributorProduct.mockResolvedValue({ id: 'dp1' })
    mockGetPriceHistory.mockResolvedValue([])
    const res = await GET(new Request('http://localhost') as never, { params })
    expect(res.status).toBe(200)
  })
})
