import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, PATCH } from '../route'
import { ClientVisibleError } from '@/lib/client-visible-error'
import {
  LOAN_RETURN_ALREADY_CANCELLED_ERROR,
  LOAN_RETURN_NOT_FOUND_ERROR,
} from '@/lib/loan-returns/repository'

const mockRequireAuth = vi.fn()
const mockRequireFacilityAccess = vi.fn()
const mockCancelLoanReturn = vi.fn()
const mockGetLoanReturn = vi.fn()
const mockRecordHiddenRowDenial = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({}),
}))
vi.mock('@/lib/supabase/require-auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}))
vi.mock('@/lib/supabase/require-facility-access', () => ({
  requireFacilityAccess: (...args: unknown[]) => mockRequireFacilityAccess(...args),
}))
vi.mock('@/lib/loan-returns/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/loan-returns/repository')>()
  return {
    ...actual,
    cancelLoanReturn: (...args: unknown[]) => mockCancelLoanReturn(...args),
    getLoanReturn: (...args: unknown[]) => mockGetLoanReturn(...args),
  }
})
vi.mock('@/lib/security/hidden-row-denial', () => ({
  recordHiddenRowDenial: (...args: unknown[]) => mockRecordHiddenRowDenial(...args),
}))

const FACILITY = '11111111-1111-4111-8111-111111111111'
const context = { params: Promise.resolve({ id: 'lr-1' }) }

function request(body: unknown) {
  return new NextRequest('http://localhost/api/loan-returns/lr-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAuth.mockResolvedValue({ id: 'u1' })
  mockRequireFacilityAccess.mockResolvedValue(FACILITY)
})

// WHY(E-056): 間違えた返却を取り消せるようにした入口。**できるのは取り消しだけ**で、
//      状態を自由に入れられないことと、失敗の理由が利用者に分かる形で返ることを固定する。
describe('PATCH /api/loan-returns/[id]（返却の取り消し・E-056）', () => {
  it('取り消しに成功すると 200 で返却を返す', async () => {
    mockCancelLoanReturn.mockResolvedValue({ id: 'lr-1', status: 'cancelled' })
    const res = await PATCH(request({ facilityId: FACILITY, action: 'cancel' }), context)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ return: { id: 'lr-1', status: 'cancelled' } })
    expect(mockCancelLoanReturn).toHaveBeenCalledWith(expect.anything(), FACILITY, 'lr-1')
  })

  // WHY: action を literal にしてあるので、状態を自由に入れる PATCH にはならない。
  //      「取り消し以外はできない」を入口の形で守っている
  it('action が cancel 以外なら 400（状態を自由に入れられない）', async () => {
    const res = await PATCH(request({ facilityId: FACILITY, action: 'returned' }), context)
    expect(res.status).toBe(400)
    expect(mockCancelLoanReturn).not.toHaveBeenCalled()
  })

  it('status を直接送っても通らない（action が無いので 400）', async () => {
    const res = await PATCH(request({ facilityId: FACILITY, status: 'draft' }), context)
    expect(res.status).toBe(400)
    expect(mockCancelLoanReturn).not.toHaveBeenCalled()
  })

  it('他施設なら 403（取り消しに進まない）', async () => {
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const res = await PATCH(request({ facilityId: FACILITY, action: 'cancel' }), context)
    expect(res.status).toBe(403)
    expect(mockCancelLoanReturn).not.toHaveBeenCalled()
  })

  it('未認証なら 401（取り消しに進まない）', async () => {
    mockRequireAuth.mockRejectedValue(new Error('UNAUTHORIZED'))
    const res = await PATCH(request({ facilityId: FACILITY, action: 'cancel' }), context)
    expect(res.status).toBe(401)
    expect(mockCancelLoanReturn).not.toHaveBeenCalled()
  })

  // WHY(404 と 409 を分ける): 「無い」と「もう取り消してある」は利用者にとって別の話。
  //      同じ 400 台でも、次にやることが違う（探し直す／何もしなくてよい）
  it('見つからないときは 404', async () => {
    mockCancelLoanReturn.mockRejectedValue(new ClientVisibleError(LOAN_RETURN_NOT_FOUND_ERROR))
    const res = await PATCH(request({ facilityId: FACILITY, action: 'cancel' }), context)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('返却が見つかりません')
  })

  it('すでに取り消し済みなら 409', async () => {
    mockCancelLoanReturn.mockRejectedValue(
      new ClientVisibleError(LOAN_RETURN_ALREADY_CANCELLED_ERROR)
    )
    const res = await PATCH(request({ facilityId: FACILITY, action: 'cancel' }), context)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('この返却はすでに取り消されています')
  })

  // WHY: DB の生のエラー（制約名・表名を含む）をそのまま返さない。500 に写す
  it('予期しないエラーは 500 で、詳細を漏らさない', async () => {
    mockCancelLoanReturn.mockRejectedValue(new Error('relation "loan_returns" does not exist'))
    const res = await PATCH(request({ facilityId: FACILITY, action: 'cancel' }), context)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('返却の取り消しに失敗しました')
    expect(JSON.stringify(body)).not.toContain('relation')
  })
})

// WHY(issue #809 Set B): GET /api/loan-returns/[id]（詳細ページの土台）に
//      route テストが1つも無かった（レビュー指摘: 正しさ critical）。
//      case-orders/[id] の GET テストと同じ形で、先引き→施設判定を固定する。
const VALID_ID = '22222222-2222-4222-8222-222222222222'
const getContext = { params: Promise.resolve({ id: VALID_ID }) }

function getRequest() {
  return new NextRequest(`http://localhost/api/loan-returns/${VALID_ID}`)
}

const LOAN_RETURN = {
  id: VALID_ID,
  facilityId: 'f1',
  returnDatetime: '2026-01-01T00:00:00Z',
  status: 'returned',
  items: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

describe('GET /api/loan-returns/[id]（issue #809）', () => {
  it('未認証なら401（repositoryに進まない）', async () => {
    mockRequireAuth.mockRejectedValue(new Error('UNAUTHORIZED'))
    const res = await GET(getRequest(), getContext)
    expect(res.status).toBe(401)
    expect(mockGetLoanReturn).not.toHaveBeenCalled()
  })

  // WHY: SPEC.md 受け入れ条件「形式が不正なIDは404か400で、500にならない」。
  //      実装は存在の有無も形式の正否も漏らさない側に倒し、404で統一している。
  //      SPEC.md Part2「認可の形」の順序（requireAuth → ID の形式 → get*）どおり、
  //      形式チェックの前に requireAuth は呼ばれる（未認証は形式によらず先に401で止める）
  it('IDの形式が不正なら404（DBへ投げない。500にしない）', async () => {
    const badContext = { params: Promise.resolve({ id: 'not-a-uuid' }) }
    const res = await GET(getRequest(), badContext)
    expect(res.status).toBe(404)
    expect(mockGetLoanReturn).not.toHaveBeenCalled()
    expect(mockRequireAuth).toHaveBeenCalled()
  })

  // WHY: SPEC.md Part2「認可の形」の順序どおり、未認証者は ID の形式が不正でも
  //      404 ではなく 401 で止まる
  it('未認証かつIDの形式も不正なら401（形式より先に認証で止まる）', async () => {
    mockRequireAuth.mockRejectedValue(new Error('UNAUTHORIZED'))
    const badContext = { params: Promise.resolve({ id: 'not-a-uuid' }) }
    const res = await GET(getRequest(), badContext)
    expect(res.status).toBe(401)
    expect(mockGetLoanReturn).not.toHaveBeenCalled()
  })

  it('見つからない（RLSで見えない・存在しない）なら404で、拒否をrecordHiddenRowDenialに残す', async () => {
    mockGetLoanReturn.mockResolvedValue(null)
    const res = await GET(getRequest(), getContext)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('返却が見つかりません')
    expect(mockRecordHiddenRowDenial).toHaveBeenCalledWith({ table: 'loan_returns', id: VALID_ID, actorId: 'u1' })
    expect(mockRequireFacilityAccess).not.toHaveBeenCalled()
  })

  it('見つかっても他施設（requireFacilityAccessが失敗）なら404（403にしない。存在を漏らさない）', async () => {
    mockGetLoanReturn.mockResolvedValue(LOAN_RETURN)
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const res = await GET(getRequest(), getContext)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('返却が見つかりません')
  })

  it('自施設のメンバーなら200で1件（ヘッダ+明細）を返す', async () => {
    mockGetLoanReturn.mockResolvedValue(LOAN_RETURN)
    const res = await GET(getRequest(), getContext)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ loanReturn: LOAN_RETURN })
    expect(mockRequireFacilityAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'f1')
    expect(mockRecordHiddenRowDenial).not.toHaveBeenCalled()
  })

  it('repositoryが例外を投げたら500で、エラー本文を応答に出さない', async () => {
    mockGetLoanReturn.mockRejectedValue(new Error('relation "loan_returns" does not exist'))
    const res = await GET(getRequest(), getContext)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('返却の取得に失敗しました')
    expect(JSON.stringify(body)).not.toContain('relation')
  })
})
