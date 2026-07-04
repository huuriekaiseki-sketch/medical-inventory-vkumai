import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '../route'

const mockGetUser = vi.fn()
const mockRequireFacilityAccess = vi.fn()
const mockListConsumablesByFacility = vi.fn()
const mockCreateConsumable = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/supabase/require-facility-access', () => ({
  requireFacilityAccess: (...args: unknown[]) => mockRequireFacilityAccess(...args),
}))

vi.mock('@/lib/consumables/repository', () => ({
  listConsumablesByFacility: (...args: unknown[]) => mockListConsumablesByFacility(...args),
  createConsumable: (...args: unknown[]) => mockCreateConsumable(...args),
}))

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

const validBody = { facilityId: 'f1', name: '品名', jan: '123', purpose: '用途' }

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f1' })
})

describe('POST /api/consumables', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validBody) })
    const res = await POST(req as never)
    expect(res.status).toBe(401)
    expect(mockCreateConsumable).not.toHaveBeenCalled()
  })

  it('施設アクセス権がない場合は403を返す', async () => {
    authenticated()
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validBody) })
    const res = await POST(req as never)
    expect(res.status).toBe(403)
    expect(mockCreateConsumable).not.toHaveBeenCalled()
  })

  it('認証済み・アクセス権ありで正常に作成できる', async () => {
    authenticated()
    mockCreateConsumable.mockResolvedValue({ id: 'c1', ...validBody })
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validBody) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    expect(mockRequireFacilityAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'f1')
  })
})
