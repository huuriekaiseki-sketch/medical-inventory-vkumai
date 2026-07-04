import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, PUT, DELETE } from '../route'

const mockGetUser = vi.fn()
const mockGetProduct = vi.fn()
const mockUpdateProduct = vi.fn()
const mockDeleteProduct = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/products/repository', () => ({
  getProduct: (...args: unknown[]) => mockGetProduct(...args),
  updateProduct: (...args: unknown[]) => mockUpdateProduct(...args),
  deleteProduct: (...args: unknown[]) => mockDeleteProduct(...args),
}))

const context = { params: Promise.resolve({ id: 'p1' }) }
const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/products/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(401)
    expect(mockGetProduct).not.toHaveBeenCalled()
  })

  it('認証済みで正常に取得できる', async () => {
    authenticated()
    mockGetProduct.mockResolvedValue({ id: 'p1', jan: '123', ref: 'r1' })
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(200)
  })
})

describe('PUT /api/products/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ jan: '1', ref: 'r' }) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(401)
    expect(mockUpdateProduct).not.toHaveBeenCalled()
  })

  it('認証済みで正常に更新できる', async () => {
    authenticated()
    mockUpdateProduct.mockResolvedValue({ id: 'p1', jan: '1', ref: 'r' })
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ jan: '1', ref: 'r' }) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(200)
  })
})

describe('DELETE /api/products/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await DELETE(new Request('http://localhost') as never, context)
    expect(res.status).toBe(401)
    expect(mockDeleteProduct).not.toHaveBeenCalled()
  })

  it('認証済みで正常に削除できる', async () => {
    authenticated()
    mockDeleteProduct.mockResolvedValue(undefined)
    const res = await DELETE(new Request('http://localhost') as never, context)
    expect(res.status).toBe(200)
  })
})
