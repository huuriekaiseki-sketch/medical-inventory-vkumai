import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

const mockGetUser = vi.fn()
const mockRequireFacilityAccess = vi.fn()
const mockListOrders = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/supabase/require-facility-access', () => ({
  requireFacilityAccess: (...args: unknown[]) => mockRequireFacilityAccess(...args),
}))

vi.mock('@/lib/orders/repository', () => ({
  listOrders: (...args: unknown[]) => mockListOrders(...args),
}))

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f1' })
  mockListOrders.mockResolvedValue([])
})

describe('GET /api/orders', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1'))
    expect(res.status).toBe(401)
    expect(mockListOrders).not.toHaveBeenCalled()
  })

  it('facility_id未指定の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders'))
    expect(res.status).toBe(400)
    expect(mockListOrders).not.toHaveBeenCalled()
  })

  it('他施設のfacility_idを指定した場合は403を返す', async () => {
    authenticated()
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f9'))
    expect(res.status).toBe(403)
    expect(mockListOrders).not.toHaveBeenCalled()
  })

  it('limitが数値でない場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1&limit=abc'))
    expect(res.status).toBe(400)
    expect(mockListOrders).not.toHaveBeenCalled()
  })

  it('limitが負数の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1&limit=-1'))
    expect(res.status).toBe(400)
    expect(mockListOrders).not.toHaveBeenCalled()
  })

  it('limitが上限(200)を超える場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1&limit=9999'))
    expect(res.status).toBe(400)
    expect(mockListOrders).not.toHaveBeenCalled()
  })

  it('limitが0の場合は400を返す（1未満は不可）', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1&limit=0'))
    expect(res.status).toBe(400)
    expect(mockListOrders).not.toHaveBeenCalled()
  })

  it('offsetが負数の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1&offset=-1'))
    expect(res.status).toBe(400)
    expect(mockListOrders).not.toHaveBeenCalled()
  })

  it('kindが不正な値の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1&kind=invalid_kind'))
    expect(res.status).toBe(400)
    expect(mockListOrders).not.toHaveBeenCalled()
  })

  it('kind=case_orderを指定するとfilter.kindにcase_orderが渡る', async () => {
    authenticated()
    mockListOrders.mockResolvedValue([
      { id: 'o1', kind: 'case_order', facilityId: 'f1', status: 'draft', summary: '手技A', createdAt: '2026-07-01T00:00:00Z' },
    ])
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1&kind=case_order'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.orders).toHaveLength(1)
    expect(mockListOrders).toHaveBeenCalledWith(
      expect.anything(),
      'f1',
      expect.objectContaining({ kind: 'case_order' }),
      50,
      0
    )
  })

  it('date_from/date_to/keywordがfilterに渡る', async () => {
    authenticated()
    const res = await GET(
      new NextRequest(
        'http://localhost/api/orders?facility_id=f1&date_from=2026-07-01&date_to=2026-07-13&keyword=%E3%82%B7%E3%83%AA%E3%83%B3%E3%82%B8'
      )
    )
    expect(res.status).toBe(200)
    expect(mockListOrders).toHaveBeenCalledWith(
      expect.anything(),
      'f1',
      expect.objectContaining({ dateFrom: '2026-07-01', dateTo: '2026-07-13', keyword: 'シリンジ' }),
      50,
      0
    )
  })

  it('limit/offset省略時はデフォルト値(50, 0)を使う', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1'))
    expect(res.status).toBe(200)
    expect(mockListOrders).toHaveBeenCalledWith(expect.anything(), 'f1', expect.anything(), 50, 0)
  })

  it('limit/offsetを指定するとそのまま渡る', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1&limit=10&offset=20'))
    expect(res.status).toBe(200)
    expect(mockListOrders).toHaveBeenCalledWith(expect.anything(), 'f1', expect.anything(), 10, 20)
  })

  it('date_fromが不正な形式の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1&date_from=abc'))
    expect(res.status).toBe(400)
    expect(mockListOrders).not.toHaveBeenCalled()
  })

  it('date_toが不正な形式の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1&date_to=2026-13-45'))
    expect(res.status).toBe(400)
    expect(mockListOrders).not.toHaveBeenCalled()
  })

  it('例外発生時は500を返す', async () => {
    authenticated()
    mockListOrders.mockRejectedValue(new Error('DB error'))
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1'))
    expect(res.status).toBe(500)
  })
})
