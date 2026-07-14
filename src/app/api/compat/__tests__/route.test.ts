import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from '../route'

const mockGetUser = vi.fn()
const mockResolveIsAdmin = vi.fn()
const mockListCompatibilities = vi.fn()
const mockCreateCompatibility = vi.fn()
const mockListProductsInCategory = vi.fn()
const mockCategoryExists = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/admin-status', () => ({
  resolveIsAdmin: (...args: unknown[]) => mockResolveIsAdmin(...args),
}))

vi.mock('@/lib/compatibilities/repository', () => ({
  listCompatibilities: (...args: unknown[]) => mockListCompatibilities(...args),
  createCompatibility: (...args: unknown[]) => mockCreateCompatibility(...args),
  listProductsInCategory: (...args: unknown[]) => mockListProductsInCategory(...args),
  categoryExists: (...args: unknown[]) => mockCategoryExists(...args),
}))

const CATEGORY_ID = '11111111-1111-1111-1111-111111111111'
const PRODUCT_ID_1 = '22222222-2222-2222-2222-222222222222'
const PRODUCT_ID_2 = '33333333-3333-3333-3333-333333333333'

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
  // WHY: 既存テストの多くはカテゴリ存在チェックの後続分岐(productsInCategory等)を
  // 検証したいだけなので、デフォルトは「カテゴリは存在する」にしておき、
  // 存在しないケースのみ個別テストでfalseに上書きする。
  mockCategoryExists.mockResolvedValue(true)
})

describe('GET /api/compat', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new NextRequest('http://localhost/api/compat'))
    expect(res.status).toBe(401)
    expect(mockListCompatibilities).not.toHaveBeenCalled()
  })

  it('認証済みで一覧を取得できる', async () => {
    authenticated()
    mockListCompatibilities.mockResolvedValue([{ id: 'c1' }])
    const res = await GET(new NextRequest('http://localhost/api/compat'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.compatibilities).toEqual([{ id: 'c1' }])
  })

  it('keywordが100文字を超える場合は400を返す', async () => {
    authenticated()
    const longKeyword = 'a'.repeat(101)
    const res = await GET(new NextRequest(`http://localhost/api/compat?keyword=${longKeyword}`))
    expect(res.status).toBe(400)
    expect(mockListCompatibilities).not.toHaveBeenCalled()
  })
})

describe('POST /api/compat', () => {
  const validBody = {
    categoryId: CATEGORY_ID,
    productId1: PRODUCT_ID_1,
    productId2: PRODUCT_ID_2,
    note: null,
  }

  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const req = new Request('http://localhost/api/compat', { method: 'POST', body: JSON.stringify(validBody) })
    const res = await POST(req as never)
    expect(res.status).toBe(401)
    expect(mockCreateCompatibility).not.toHaveBeenCalled()
  })

  it('一般ユーザーの場合は403を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(false)
    const req = new Request('http://localhost/api/compat', { method: 'POST', body: JSON.stringify(validBody) })
    const res = await POST(req as never)
    expect(res.status).toBe(403)
    expect(mockCreateCompatibility).not.toHaveBeenCalled()
  })

  it('自己参照の場合は400を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    const req = new Request('http://localhost/api/compat', {
      method: 'POST',
      body: JSON.stringify({ ...validBody, productId2: PRODUCT_ID_1 }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
    expect(mockListProductsInCategory).not.toHaveBeenCalled()
  })

  it('不正なUUID形式の場合は400を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    const req = new Request('http://localhost/api/compat', {
      method: 'POST',
      body: JSON.stringify({ ...validBody, categoryId: 'not-a-uuid' }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('noteが501文字の場合は400を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    const req = new Request('http://localhost/api/compat', {
      method: 'POST',
      body: JSON.stringify({ ...validBody, note: 'a'.repeat(501) }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('存在しないcategoryIdの場合は400を返し「カテゴリが見つかりません」を含む', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    mockCategoryExists.mockResolvedValue(false)
    const req = new Request('http://localhost/api/compat', { method: 'POST', body: JSON.stringify(validBody) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('カテゴリが見つかりません')
    expect(mockListProductsInCategory).not.toHaveBeenCalled()
    expect(mockCreateCompatibility).not.toHaveBeenCalled()
  })

  it('カテゴリ外の製品を指定した場合は400を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    mockListProductsInCategory.mockResolvedValue([])
    const req = new Request('http://localhost/api/compat', { method: 'POST', body: JSON.stringify(validBody) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
    expect(mockCreateCompatibility).not.toHaveBeenCalled()
  })

  it('重複ペアの場合は409を返し製品名を含む', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    mockListProductsInCategory.mockResolvedValue([
      { id: PRODUCT_ID_1, name: '製品A', jan: 'JAN1', maker: null },
      { id: PRODUCT_ID_2, name: '製品B', jan: 'JAN2', maker: null },
    ])
    mockCreateCompatibility.mockRejectedValue(new Error('duplicate key value violates unique constraint (23505)'))
    const req = new Request('http://localhost/api/compat', { method: 'POST', body: JSON.stringify(validBody) })
    const res = await POST(req as never)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('製品A')
    expect(body.error).toContain('製品B')
  })

  it('正常なリクエストで201を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    mockListProductsInCategory.mockResolvedValue([
      { id: PRODUCT_ID_1, name: '製品A', jan: 'JAN1', maker: null },
      { id: PRODUCT_ID_2, name: '製品B', jan: 'JAN2', maker: null },
    ])
    mockCreateCompatibility.mockResolvedValue({ id: 'c1' })
    const req = new Request('http://localhost/api/compat', { method: 'POST', body: JSON.stringify(validBody) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
  })
})
