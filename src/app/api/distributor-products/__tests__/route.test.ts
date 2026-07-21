import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from '../route'

const mockGetUser = vi.fn()
const mockResolveIsAdmin = vi.fn()
const mockCreateDistributorProduct = vi.fn()
const mockListDistributorProducts = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/admin-status', () => ({
  resolveIsAdmin: (...args: unknown[]) => mockResolveIsAdmin(...args),
}))

vi.mock('@/lib/distributor-products/repository', () => ({
  listDistributorProducts: (...args: unknown[]) => mockListDistributorProducts(...args),
  createDistributorProduct: (...args: unknown[]) => mockCreateDistributorProduct(...args),
}))

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })
const validInput = { productId: 'p1', maker: 'maker', supplier: 'supplier', name: 'name', categoryId: 'cat1' }

function makeGetRequest(url: string) {
  return new NextRequest(`http://localhost${url}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveIsAdmin.mockResolvedValue(true)
  authenticated()
})

describe('GET /api/distributor-products', () => {
  it('一覧を返す', async () => {
    mockListDistributorProducts.mockResolvedValue([{ id: 'dp1', ...validInput }])
    const res = await GET(makeGetRequest('/api/distributor-products') as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
  })

  it('keywordをlistDistributorProductsに渡す', async () => {
    mockListDistributorProducts.mockResolvedValue([])
    await GET(makeGetRequest('/api/distributor-products?keyword=abc') as never)
    expect(mockListDistributorProducts).toHaveBeenCalledWith(expect.anything(), { keyword: 'abc', categoryId: undefined })
  })

  it('categoryIdが正しいUUID形式ならlistDistributorProductsに渡す', async () => {
    mockListDistributorProducts.mockResolvedValue([])
    const categoryId = '11111111-1111-4111-8111-111111111111'
    await GET(makeGetRequest(`/api/distributor-products?categoryId=${categoryId}`) as never)
    expect(mockListDistributorProducts).toHaveBeenCalledWith(expect.anything(), { keyword: undefined, categoryId })
  })

  it('categoryIdが不正な形式なら400を返す', async () => {
    const res = await GET(makeGetRequest('/api/distributor-products?categoryId=not-a-uuid') as never)
    expect(res.status).toBe(400)
    expect(mockListDistributorProducts).not.toHaveBeenCalled()
  })

  it('keywordが101文字なら400を返す', async () => {
    const res = await GET(makeGetRequest(`/api/distributor-products?keyword=${'a'.repeat(101)}`) as never)
    expect(res.status).toBe(400)
    expect(mockListDistributorProducts).not.toHaveBeenCalled()
  })

  it('未認証なら401を返す', async () => {
    unauthenticated()
    const res = await GET(makeGetRequest('/api/distributor-products') as never)
    expect(res.status).toBe(401)
  })

  it('DBエラー時は生のエラーメッセージを含まないレスポンスを返す', async () => {
    mockListDistributorProducts.mockRejectedValue(new Error('relation "distributor_products" does not exist'))
    const res = await GET(makeGetRequest('/api/distributor-products') as never)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).not.toContain('relation')
  })
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
