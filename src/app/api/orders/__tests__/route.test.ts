import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

const mockGetUser = vi.fn()
const mockRequireFacilityAccess = vi.fn()
const mockFetchUnifiedOrders = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/supabase/require-facility-access', () => ({
  requireFacilityAccess: (...args: unknown[]) => mockRequireFacilityAccess(...args),
}))

// WHY: src/lib/orders/unified-repository.ts はSET-D内の別ファイル（本セットの担当範囲外）。
// SPEC.md Part2 SET-D記載の型（OrdersFilter → OrdersGetResponse）に従い、
// fetchUnifiedOrders(db, filter) というシグネチャを前提にモックする
vi.mock('@/lib/orders/unified-repository', () => ({
  fetchUnifiedOrders: (...args: unknown[]) => mockFetchUnifiedOrders(...args),
}))

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f1' })
  mockFetchUnifiedOrders.mockResolvedValue({ orders: [], errors: [] })
})

describe('GET /api/orders', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders'))
    expect(res.status).toBe(401)
    expect(mockFetchUnifiedOrders).not.toHaveBeenCalled()
  })

  it('非adminがfacility_idを省略した場合は400を返す', async () => {
    authenticated()
    mockRequireFacilityAccess.mockRejectedValue(new Error('FACILITY_ID_REQUIRED'))
    const res = await GET(new NextRequest('http://localhost/api/orders'))
    expect(res.status).toBe(400)
    expect(mockFetchUnifiedOrders).not.toHaveBeenCalled()
  })

  it('非adminが他施設のfacility_idを指定した場合は403を返す', async () => {
    authenticated()
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f9'))
    expect(res.status).toBe(403)
    expect(mockFetchUnifiedOrders).not.toHaveBeenCalled()
  })

  it('4種別すべて空の場合は { orders: [], errors: [] } を返す', async () => {
    authenticated()
    mockFetchUnifiedOrders.mockResolvedValue({ orders: [], errors: [] })
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ orders: [], errors: [] })
  })

  it('正常系: facility_id・date_from・date_to・product_search・order_kindsをフィルタとして渡す', async () => {
    authenticated()
    mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f1' })
    mockFetchUnifiedOrders.mockResolvedValue({
      orders: [
        { id: 'o1', kind: 'case', facilityId: 'f1', displayDatetime: '2026-07-10T00:00:00Z', status: 'submitted', summaryLabel: '製品A' },
      ],
      errors: [],
    })

    const res = await GET(
      new NextRequest(
        'http://localhost/api/orders?facility_id=f1&date_from=2026-07-01T00:00:00Z&date_to=2026-07-31T00:00:00Z&product_search=%E8%A3%BD%E5%93%81&order_kinds=case,loan'
      )
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.orders).toHaveLength(1)
    expect(mockFetchUnifiedOrders).toHaveBeenCalledWith(
      expect.anything(),
      {
        facilityId: 'f1',
        dateFrom: '2026-07-01T00:00:00Z',
        dateTo: '2026-07-31T00:00:00Z',
        productSearch: '製品',
        orderKinds: ['case', 'loan'],
      }
    )
  })

  it('order_kinds省略時はorderKinds:undefinedとして渡す（全種別対象）', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1'))
    expect(res.status).toBe(200)
    expect(mockFetchUnifiedOrders).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderKinds: undefined })
    )
  })

  it('order_kindsに不正な値が含まれる場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1&order_kinds=case,unknown_kind'))
    expect(res.status).toBe(400)
    expect(mockFetchUnifiedOrders).not.toHaveBeenCalled()
  })

  // issue #20 レビュー指摘（important）回帰テスト: 種別チェックボックスを全て外した場合、
  // order_kinds= という空値付きパラメータがリクエストされる。これを「未指定（=全種別対象）」
  // と誤解釈すると、UIは0件選択なのに実データは全種別分が返るという矛盾が生じる。
  // orderKindsParamがnullでなければ（パラメータキー自体は存在する）、空配列をそのまま渡すこと。
  it('order_kindsが空文字（全チェックボックス解除）の場合はorderKinds:[]として渡す（全種別対象にフォールバックしない）', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1&order_kinds='))
    expect(res.status).toBe(200)
    expect(mockFetchUnifiedOrders).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderKinds: [] })
    )
  })

  it('admin・facility_id省略時はfacilityId:undefinedとして渡す（全施設対象）', async () => {
    authenticated()
    mockRequireFacilityAccess.mockResolvedValue({ facilityId: null })
    const res = await GET(new NextRequest('http://localhost/api/orders'))
    expect(res.status).toBe(200)
    expect(mockFetchUnifiedOrders).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ facilityId: undefined })
    )
  })

  it('1種別が失敗しても他の結果とerrorsを合わせて返す', async () => {
    authenticated()
    mockFetchUnifiedOrders.mockResolvedValue({
      orders: [
        { id: 'o1', kind: 'case', facilityId: 'f1', displayDatetime: '2026-07-10T00:00:00Z', status: 'submitted', summaryLabel: '製品A' },
      ],
      errors: [{ kind: 'loan', message: 'DB error' }],
    })
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.orders).toHaveLength(1)
    expect(body.errors).toEqual([{ kind: 'loan', message: 'DB error' }])
  })

  it('例外発生時は500を返す', async () => {
    authenticated()
    mockFetchUnifiedOrders.mockRejectedValue(new Error('DB error'))
    const res = await GET(new NextRequest('http://localhost/api/orders?facility_id=f1'))
    expect(res.status).toBe(500)
  })
})
