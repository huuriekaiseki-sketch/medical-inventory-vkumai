import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

const mockGetUser = vi.fn()
const mockResolveIsAdmin = vi.fn()
const mockFetchOrderAmountReport = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/admin-status', () => ({
  resolveIsAdmin: (...args: unknown[]) => mockResolveIsAdmin(...args),
}))

vi.mock('@/lib/reports/repository', () => ({
  fetchOrderAmountReport: (...args: unknown[]) => mockFetchOrderAmountReport(...args),
}))

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

const ROW = {
  facilityId: 'f1',
  facilityName: '施設A',
  caseOrderAmount: 1000,
  caseOrderCount: 2,
  caseOrderTotalCount: 2,
  consumableOrderAmount: null,
  consumableOrderCount: 0,
  consumableOrderTotalCount: 0,
  loanOrderAmount: 0,
  loanOrderCount: 1,
  loanOrderTotalCount: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/admin/reports', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new NextRequest('http://localhost/api/admin/reports'))
    expect(res.status).toBe(401)
    expect(mockFetchOrderAmountReport).not.toHaveBeenCalled()
  })

  it('一般ユーザー(非admin)の場合は403を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(false)
    const res = await GET(new NextRequest('http://localhost/api/admin/reports'))
    expect(res.status).toBe(403)
    expect(mockFetchOrderAmountReport).not.toHaveBeenCalled()
  })

  it('date_fromが不正な形式の場合は400を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    const res = await GET(new NextRequest('http://localhost/api/admin/reports?date_from=not-a-date'))
    expect(res.status).toBe(400)
    expect(mockFetchOrderAmountReport).not.toHaveBeenCalled()
  })

  it('date_toが不正な形式の場合は400を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    const res = await GET(new NextRequest('http://localhost/api/admin/reports?date_to=2026-13-40'))
    expect(res.status).toBe(400)
    expect(mockFetchOrderAmountReport).not.toHaveBeenCalled()
  })

  it('date_from > date_to の場合は400を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    const res = await GET(new NextRequest('http://localhost/api/admin/reports?date_from=2026-07-10&date_to=2026-07-01'))
    expect(res.status).toBe(400)
    expect(mockFetchOrderAmountReport).not.toHaveBeenCalled()
  })

  it('adminユーザーで正常にレポートを取得できる', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    mockFetchOrderAmountReport.mockResolvedValue([ROW])
    const res = await GET(new NextRequest('http://localhost/api/admin/reports?date_from=2026-07-01&date_to=2026-07-10'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([ROW])
    expect(mockFetchOrderAmountReport).toHaveBeenCalledWith(
      expect.anything(),
      { dateFrom: '2026-07-01', dateTo: '2026-07-10' },
    )
  })

  it('date_from/date_to省略時はfilterが空オブジェクトで呼ばれる', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    mockFetchOrderAmountReport.mockResolvedValue([])
    const res = await GET(new NextRequest('http://localhost/api/admin/reports'))
    expect(res.status).toBe(200)
    expect(mockFetchOrderAmountReport).toHaveBeenCalledWith(expect.anything(), {})
  })

  it('repositoryがpermission deniedを投げた場合は403に変換する', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    mockFetchOrderAmountReport.mockRejectedValue(new Error('permission denied'))
    const res = await GET(new NextRequest('http://localhost/api/admin/reports'))
    expect(res.status).toBe(403)
  })

  it('repositoryがその他のエラーを投げた場合は500を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    mockFetchOrderAmountReport.mockRejectedValue(new Error('db error'))
    const res = await GET(new NextRequest('http://localhost/api/admin/reports'))
    expect(res.status).toBe(500)
  })
})
