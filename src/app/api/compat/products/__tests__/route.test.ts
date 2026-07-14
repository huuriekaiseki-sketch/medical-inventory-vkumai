import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

const mockGetUser = vi.fn()
const mockListProductsInCategory = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/compatibilities/repository', () => ({
  listProductsInCategory: (...args: unknown[]) => mockListProductsInCategory(...args),
}))

const CATEGORY_ID = '11111111-1111-1111-1111-111111111111'

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/compat/products', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new NextRequest(`http://localhost/api/compat/products?categoryId=${CATEGORY_ID}`))
    expect(res.status).toBe(401)
    expect(mockListProductsInCategory).not.toHaveBeenCalled()
  })

  it('categoryIdが欠落している場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/compat/products'))
    expect(res.status).toBe(400)
    expect(mockListProductsInCategory).not.toHaveBeenCalled()
  })

  it('categoryIdが不正なUUID形式の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/compat/products?categoryId=not-a-uuid'))
    expect(res.status).toBe(400)
    expect(mockListProductsInCategory).not.toHaveBeenCalled()
  })

  it('認証済みで正しいcategoryIdの場合は製品一覧を返す', async () => {
    authenticated()
    mockListProductsInCategory.mockResolvedValue([{ id: 'p1', name: '製品A' }])
    const res = await GET(new NextRequest(`http://localhost/api/compat/products?categoryId=${CATEGORY_ID}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.products).toEqual([{ id: 'p1', name: '製品A' }])
    expect(mockListProductsInCategory).toHaveBeenCalledWith(expect.anything(), CATEGORY_ID)
  })
})
