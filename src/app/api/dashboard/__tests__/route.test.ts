import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '../route'

const mockGetUser = vi.fn()
const mockListUserFacilities = vi.fn()
const mockGetFacilityOrderSummary = vi.fn()
const mockGetLoanOutstandingCount = vi.fn()
const mockListRecentPriceHistories = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/user-facilities/repository', () => ({
  listUserFacilities: (...args: unknown[]) => mockListUserFacilities(...args),
}))

vi.mock('@/lib/dashboard/facility-summary', () => ({
  getFacilityOrderSummary: (...args: unknown[]) => mockGetFacilityOrderSummary(...args),
}))

vi.mock('@/lib/dashboard/loan-outstanding', () => ({
  getLoanOutstandingCount: (...args: unknown[]) => mockGetLoanOutstandingCount(...args),
}))

vi.mock('@/lib/price-histories/repository', () => ({
  listRecentPriceHistories: (...args: unknown[]) => mockListRecentPriceHistories(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/dashboard', () => {
  it('未認証の場合は401を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })

    const res = await GET()
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBeTruthy()
  })

  it('所属施設が0件の場合、空配列とisAdmin:falseを返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })
    mockListUserFacilities.mockResolvedValue([])
    mockListRecentPriceHistories.mockResolvedValue([])

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.facilitySummaries).toEqual([])
    expect(body.loanOutstanding).toEqual([])
    expect(body.recentPriceChanges).toEqual([])
    expect(body.isAdmin).toBe(false)
    expect(mockGetFacilityOrderSummary).not.toHaveBeenCalled()
    expect(mockGetLoanOutstandingCount).not.toHaveBeenCalled()
  })

  it('正常系: 所属施設ごとにサマリー・未返却件数を集約し、admin判定・価格改定一覧を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })
    mockListUserFacilities.mockResolvedValue([
      { facilityId: 'f1', facilityName: '施設A', role: 'staff' },
      { facilityId: 'f2', facilityName: '施設B', role: 'admin' },
    ])
    mockGetFacilityOrderSummary.mockImplementation(async (_db: unknown, facilityId: string) => ({
      facilityId,
      caseOrderCount: 1,
      caseOrderLatestAt: '2026-07-01T00:00:00Z',
      consumableOrderCount: 2,
      consumableOrderLatestAt: '2026-07-02T00:00:00Z',
      loanOrderCount: 3,
      loanOrderLatestAt: '2026-07-03T00:00:00Z',
    }))
    mockGetLoanOutstandingCount.mockImplementation(async (_db: unknown, facilityId: string) =>
      facilityId === 'f1' ? 2 : 0
    )
    mockListRecentPriceHistories.mockResolvedValue([
      { id: 'p1', entityType: 'distributor_product', entityId: 'e1', distributorProductId: 'dp1', fieldName: 'reimbursement_price', oldValue: 100, newValue: 120, changedAt: '2026-07-03T00:00:00Z', facilityName: null, productName: '商品X' },
    ])

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.isAdmin).toBe(true)
    expect(body.facilitySummaries).toHaveLength(2)
    expect(body.facilitySummaries[0]).toMatchObject({
      facilityId: 'f1',
      facilityName: '施設A',
      caseOrderCount: 1,
      loanOrderCount: 3,
    })
    expect(body.loanOutstanding).toEqual([
      { facilityId: 'f1', facilityName: '施設A', outstandingCount: 2 },
      { facilityId: 'f2', facilityName: '施設B', outstandingCount: 0 },
    ])
    expect(body.recentPriceChanges).toHaveLength(1)
    expect(mockGetFacilityOrderSummary).toHaveBeenCalledWith(expect.anything(), 'f1')
    expect(mockGetFacilityOrderSummary).toHaveBeenCalledWith(expect.anything(), 'f2')
  })

  it('施設間データ隔離: listUserFacilitiesが返した施設IDのみに対してサマリー取得が行われる', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })
    mockListUserFacilities.mockResolvedValue([
      { facilityId: 'f1', facilityName: '施設A', role: 'staff' },
    ])
    mockGetFacilityOrderSummary.mockResolvedValue({
      facilityId: 'f1',
      caseOrderCount: 0,
      caseOrderLatestAt: null,
      consumableOrderCount: 0,
      consumableOrderLatestAt: null,
      loanOrderCount: 0,
      loanOrderLatestAt: null,
    })
    mockGetLoanOutstandingCount.mockResolvedValue(0)
    mockListRecentPriceHistories.mockResolvedValue([])

    const res = await GET()
    const body = await res.json()

    expect(body.facilitySummaries).toHaveLength(1)
    expect(body.loanOutstanding).toHaveLength(1)
    expect(mockGetFacilityOrderSummary).toHaveBeenCalledTimes(1)
    expect(mockGetFacilityOrderSummary).not.toHaveBeenCalledWith(expect.anything(), 'f2')
  })

  it('例外発生時は500を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })
    mockListUserFacilities.mockRejectedValue(new Error('DB error'))

    const res = await GET()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBeTruthy()
  })
})
