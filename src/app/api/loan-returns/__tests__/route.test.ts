import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from '../route'
import { ClientVisibleError } from '@/lib/client-visible-error'

const mockGetUser = vi.fn()
const mockRequireFacilityAccess = vi.fn()
const mockListLoanReturns = vi.fn()
const mockCreateLoanReturn = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/supabase/require-facility-access', () => ({
  requireFacilityAccess: (...args: unknown[]) => mockRequireFacilityAccess(...args),
}))

vi.mock('@/lib/loan-returns/repository', () => ({
  listLoanReturns: (...args: unknown[]) => mockListLoanReturns(...args),
  createLoanReturn: (...args: unknown[]) => mockCreateLoanReturn(...args),
  LOAN_ORDER_NOT_FOUND_ERROR: '指定された短貸発注が見つかりません',
}))

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f1' })
  mockListLoanReturns.mockResolvedValue([])
  mockCreateLoanReturn.mockResolvedValue({ id: 'lr1' })
})

describe('GET /api/loan-returns', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new NextRequest('http://localhost/api/loan-returns?facility_id=f1'))
    expect(res.status).toBe(401)
    expect(mockListLoanReturns).not.toHaveBeenCalled()
  })

  it('facility_id未指定・非adminの場合は400を返す', async () => {
    authenticated()
    mockRequireFacilityAccess.mockRejectedValue(new Error('FACILITY_ID_REQUIRED'))
    const res = await GET(new NextRequest('http://localhost/api/loan-returns'))
    expect(res.status).toBe(400)
  })

  it('未所属施設を指定した場合は403を返す', async () => {
    authenticated()
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const res = await GET(new NextRequest('http://localhost/api/loan-returns?facility_id=f9'))
    expect(res.status).toBe(403)
  })

  it('limit/offset省略時はデフォルト値(50, 0)を使う', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/loan-returns?facility_id=f1'))
    expect(res.status).toBe(200)
    expect(mockListLoanReturns).toHaveBeenCalledWith(expect.anything(), 'f1', 50, 0)
  })

  it('limitが数値でない場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/loan-returns?facility_id=f1&limit=abc'))
    expect(res.status).toBe(400)
    expect(mockListLoanReturns).not.toHaveBeenCalled()
  })

  it('offsetが数値でない場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/loan-returns?facility_id=f1&offset=xyz'))
    expect(res.status).toBe(400)
    expect(mockListLoanReturns).not.toHaveBeenCalled()
  })

  it('limitが0の場合は400を返す（1未満は不可）', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/loan-returns?facility_id=f1&limit=0'))
    expect(res.status).toBe(400)
    expect(mockListLoanReturns).not.toHaveBeenCalled()
  })

  it('limitが負数の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/loan-returns?facility_id=f1&limit=-1'))
    expect(res.status).toBe(400)
    expect(mockListLoanReturns).not.toHaveBeenCalled()
  })

  it('limitが上限(200)を超える場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/loan-returns?facility_id=f1&limit=9999'))
    expect(res.status).toBe(400)
    expect(mockListLoanReturns).not.toHaveBeenCalled()
  })

  it('limitが上限ちょうど(200)の場合は200を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/loan-returns?facility_id=f1&limit=200'))
    expect(res.status).toBe(200)
    expect(mockListLoanReturns).toHaveBeenCalledWith(expect.anything(), 'f1', 200, 0)
  })

  it('offsetが負数の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/loan-returns?facility_id=f1&offset=-5'))
    expect(res.status).toBe(400)
    expect(mockListLoanReturns).not.toHaveBeenCalled()
  })

  it('正常系: limit・offset指定時にそのまま渡る', async () => {
    authenticated()
    mockListLoanReturns.mockResolvedValue([{ id: 'r1' }])
    const res = await GET(new NextRequest('http://localhost/api/loan-returns?facility_id=f1&limit=10&offset=20'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.returns).toEqual([{ id: 'r1' }])
    expect(mockListLoanReturns).toHaveBeenCalledWith(expect.anything(), 'f1', 10, 20)
  })

  it('例外発生時は500を返す', async () => {
    authenticated()
    mockListLoanReturns.mockRejectedValue(new Error('DB error'))
    const res = await GET(new NextRequest('http://localhost/api/loan-returns?facility_id=f1'))
    expect(res.status).toBe(500)
  })
})

describe('POST /api/loan-returns', () => {
  function makeRequest(body: unknown) {
    return new NextRequest('http://localhost/api/loan-returns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  // WHY: loan_returns作成経路でloanOrderIdを渡せないと「未返却」バッジが永久に外れない
  //      バグになる（issue #20 レビュー指摘）。bodyのloanOrderIdがrepositoryへ渡ることを検証する
  it('bodyのloanOrderIdがcreateLoanReturnの第4引数に渡る', async () => {
    authenticated()
    const res = await POST(makeRequest({
      facilityId: 'f1',
      returnDatetime: '2026-06-24T15:00:00Z',
      loanOrderId: 'lo-1',
      items: [{ jan: '490001', quantity: 1 }],
    }))
    expect(res.status).toBe(201)
    expect(mockCreateLoanReturn).toHaveBeenCalledWith(
      expect.anything(),
      'f1',
      expect.objectContaining({ returnDatetime: '2026-06-24T15:00:00Z' }),
      'lo-1'
    )
  })

  it('loanOrderId未指定の場合はundefinedのままcreateLoanReturnに渡る', async () => {
    authenticated()
    const res = await POST(makeRequest({
      facilityId: 'f1',
      returnDatetime: '2026-06-24T15:00:00Z',
      items: [{ jan: '490001', quantity: 1 }],
    }))
    expect(res.status).toBe(201)
    expect(mockCreateLoanReturn).toHaveBeenCalledWith(
      expect.anything(),
      'f1',
      expect.anything(),
      undefined
    )
  })

  // WHY: 他施設のloan_orders.idをloanOrderIdに指定した場合、repository層は
  //      LOAN_ORDER_NOT_FOUND_ERRORをthrowする（テナント境界チェック、issue #20 レビュー指摘:
  //      critical）。route側はこれをサーバーエラー(500)ではなく入力エラー(400)として
  //      区別して返すことを確認する
  it('loanOrderIdが自施設に存在しない場合は400を返す', async () => {
    authenticated()
    mockCreateLoanReturn.mockRejectedValue(new ClientVisibleError('指定された短貸発注が見つかりません'))
    const res = await POST(makeRequest({
      facilityId: 'f1',
      returnDatetime: '2026-06-24T15:00:00Z',
      loanOrderId: 'other-facility-lo',
      items: [{ jan: '490001', quantity: 1 }],
    }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('指定された短貸発注が見つかりません')
  })

  // WHY: 同一loan_order_idへの返却二重登録はDB側のUNIQUE制約違反(23505)として検知され、
  //      repository層がClientVisibleErrorに翻訳する（issue #675）。route側は他の
  //      ClientVisibleErrorと同様に400として返すことを確認する
  it('同一短貸発注へ返却済みの場合は400を返す', async () => {
    authenticated()
    mockCreateLoanReturn.mockRejectedValue(new ClientVisibleError('この短貸発注は既に返却登録されています'))
    const res = await POST(makeRequest({
      facilityId: 'f1',
      returnDatetime: '2026-06-24T15:00:00Z',
      loanOrderId: 'lo-1',
      items: [{ jan: '490001', quantity: 1 }],
    }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('この短貸発注は既に返却登録されています')
  })
})
