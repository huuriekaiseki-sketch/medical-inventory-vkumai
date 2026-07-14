import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

const mockGetUser = vi.fn()
const mockRequireFacilityAccess = vi.fn()
const mockListCaseOrders = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/supabase/require-facility-access', () => ({
  requireFacilityAccess: (...args: unknown[]) => mockRequireFacilityAccess(...args),
}))

vi.mock('@/lib/case-orders/repository', () => ({
  listCaseOrders: (...args: unknown[]) => mockListCaseOrders(...args),
  createCaseOrder: vi.fn(),
}))

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f1' })
  mockListCaseOrders.mockResolvedValue([])
})

describe('GET /api/case-orders', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new NextRequest('http://localhost/api/case-orders?facility_id=f1'))
    expect(res.status).toBe(401)
    expect(mockListCaseOrders).not.toHaveBeenCalled()
  })

  it('facility_id未指定・非adminの場合は400を返す', async () => {
    authenticated()
    mockRequireFacilityAccess.mockRejectedValue(new Error('FACILITY_ID_REQUIRED'))
    const res = await GET(new NextRequest('http://localhost/api/case-orders'))
    expect(res.status).toBe(400)
  })

  it('未所属施設を指定した場合は403を返す', async () => {
    authenticated()
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const res = await GET(new NextRequest('http://localhost/api/case-orders?facility_id=f9'))
    expect(res.status).toBe(403)
  })

  it('limit/offset省略時はデフォルト値(50, 0)を使う', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/case-orders?facility_id=f1'))
    expect(res.status).toBe(200)
    expect(mockListCaseOrders).toHaveBeenCalledWith(expect.anything(), 'f1', 50, 0)
  })

  it('limitが数値でない場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/case-orders?facility_id=f1&limit=abc'))
    expect(res.status).toBe(400)
    expect(mockListCaseOrders).not.toHaveBeenCalled()
  })

  it('offsetが数値でない場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/case-orders?facility_id=f1&offset=xyz'))
    expect(res.status).toBe(400)
    expect(mockListCaseOrders).not.toHaveBeenCalled()
  })

  it('limitが0の場合は400を返す（1未満は不可）', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/case-orders?facility_id=f1&limit=0'))
    expect(res.status).toBe(400)
    expect(mockListCaseOrders).not.toHaveBeenCalled()
  })

  it('limitが負数の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/case-orders?facility_id=f1&limit=-1'))
    expect(res.status).toBe(400)
    expect(mockListCaseOrders).not.toHaveBeenCalled()
  })

  it('limitが上限(200)を超える場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/case-orders?facility_id=f1&limit=9999'))
    expect(res.status).toBe(400)
    expect(mockListCaseOrders).not.toHaveBeenCalled()
  })

  it('limitが上限ちょうど(200)の場合は200を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/case-orders?facility_id=f1&limit=200'))
    expect(res.status).toBe(200)
    expect(mockListCaseOrders).toHaveBeenCalledWith(expect.anything(), 'f1', 200, 0)
  })

  it('offsetが負数の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/case-orders?facility_id=f1&offset=-5'))
    expect(res.status).toBe(400)
    expect(mockListCaseOrders).not.toHaveBeenCalled()
  })

  it('正常系: limit・offset指定時にそのまま渡る', async () => {
    authenticated()
    mockListCaseOrders.mockResolvedValue([{ id: 'c1' }])
    const res = await GET(new NextRequest('http://localhost/api/case-orders?facility_id=f1&limit=10&offset=20'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.orders).toEqual([{ id: 'c1' }])
    expect(mockListCaseOrders).toHaveBeenCalledWith(expect.anything(), 'f1', 10, 20)
  })

  it('例外発生時は500を返す', async () => {
    authenticated()
    mockListCaseOrders.mockRejectedValue(new Error('DB error'))
    const res = await GET(new NextRequest('http://localhost/api/case-orders?facility_id=f1'))
    expect(res.status).toBe(500)
  })
})
