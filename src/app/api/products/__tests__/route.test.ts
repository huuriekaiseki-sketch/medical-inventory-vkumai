import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '../route'

const mockGetUser = vi.fn()
const mockResolveIsAdmin = vi.fn()
const mockCreateProduct = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/admin-status', () => ({
  resolveIsAdmin: (...args: unknown[]) => mockResolveIsAdmin(...args),
}))

vi.mock('@/lib/products/repository', () => ({
  listProducts: vi.fn(),
  createProduct: (...args: unknown[]) => mockCreateProduct(...args),
}))

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })
const validInput = { jan: '1234567890123', ref: 'ref1', name: '製品A' }

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveIsAdmin.mockResolvedValue(true)
})

describe('POST /api/products', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validInput) })
    const res = await POST(req as never)
    expect(res.status).toBe(401)
    expect(mockCreateProduct).not.toHaveBeenCalled()
  })

  it('一般ユーザーの場合は403を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(false)
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validInput) })
    const res = await POST(req as never)
    expect(res.status).toBe(403)
    expect(mockCreateProduct).not.toHaveBeenCalled()
  })

  it('管理者は正常に作成できる', async () => {
    authenticated()
    mockCreateProduct.mockResolvedValue({ id: 'p1', ...validInput })
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validInput) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
  })
})
