import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, PUT, DELETE } from '../route'

const mockGetUser = vi.fn()
const mockGetCategory = vi.fn()
const mockUpdateCategory = vi.fn()
const mockDeleteCategory = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/categories/repository', () => ({
  getCategory: (...args: unknown[]) => mockGetCategory(...args),
  updateCategory: (...args: unknown[]) => mockUpdateCategory(...args),
  deleteCategory: (...args: unknown[]) => mockDeleteCategory(...args),
}))

const context = { params: Promise.resolve({ id: 'c1' }) }
const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/categories/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(401)
    expect(mockGetCategory).not.toHaveBeenCalled()
  })

  it('認証済みで正常に取得できる', async () => {
    authenticated()
    mockGetCategory.mockResolvedValue({ id: 'c1', name: 'カテゴリA' })
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(200)
  })
})

describe('PUT /api/categories/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ name: 'x' }) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(401)
    expect(mockUpdateCategory).not.toHaveBeenCalled()
  })

  it('認証済みで正常に更新できる', async () => {
    authenticated()
    mockUpdateCategory.mockResolvedValue({ id: 'c1', name: 'x' })
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ name: 'x' }) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(200)
  })
})

describe('DELETE /api/categories/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await DELETE(new Request('http://localhost') as never, context)
    expect(res.status).toBe(401)
    expect(mockDeleteCategory).not.toHaveBeenCalled()
  })

  it('認証済みで正常に削除できる', async () => {
    authenticated()
    mockDeleteCategory.mockResolvedValue(undefined)
    const res = await DELETE(new Request('http://localhost') as never, context)
    expect(res.status).toBe(200)
  })
})
