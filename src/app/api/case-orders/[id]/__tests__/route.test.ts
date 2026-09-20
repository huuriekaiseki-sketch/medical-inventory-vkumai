import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

// WHY(issue #809 Set B): GET /api/case-orders/[id]（詳細ページの土台）に
//      route テストが1つも無かった（レビュー指摘: 正しさ critical）。
//      SPEC.md Part2「認可の形」＝先引き→施設判定を、
//      hospital-prices/[id] の GET テストと同じ形で固定する。

const mockRequireAuth = vi.fn()
const mockRequireFacilityAccess = vi.fn()
const mockGetCaseOrder = vi.fn()
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
vi.mock('@/lib/case-orders/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/case-orders/repository')>()
  return {
    ...actual,
    getCaseOrder: (...args: unknown[]) => mockGetCaseOrder(...args),
  }
})
vi.mock('@/lib/security/hidden-row-denial', () => ({
  recordHiddenRowDenial: (...args: unknown[]) => mockRecordHiddenRowDenial(...args),
}))

const VALID_ID = '11111111-1111-4111-8111-111111111111'
const context = { params: Promise.resolve({ id: VALID_ID }) }

function request() {
  return new NextRequest(`http://localhost/api/case-orders/${VALID_ID}`)
}

const CASE_ORDER = {
  id: VALID_ID,
  facilityId: 'f1',
  caseDatetime: '2026-01-01T00:00:00Z',
  procedureName: '術式',
  patientId: 'PT-1',
  patientInitials: 'T.E.',
  gender: 'other',
  doctorName: '医師',
  status: 'submitted',
  items: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAuth.mockResolvedValue({ id: 'u1' })
  mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f1' })
})

describe('GET /api/case-orders/[id]（issue #809）', () => {
  it('未認証なら401（repositoryに進まない）', async () => {
    mockRequireAuth.mockRejectedValue(new Error('UNAUTHORIZED'))
    const res = await GET(request(), context)
    expect(res.status).toBe(401)
    expect(mockGetCaseOrder).not.toHaveBeenCalled()
  })

  // WHY: SPEC.md 受け入れ条件「形式が不正なIDは404か400で、500にならない」。
  //      実装は存在の有無も形式の正否も漏らさない側に倒し、404で統一している。
  //      SPEC.md Part2「認可の形」の順序（requireAuth → ID の形式 → get*）どおり、
  //      形式チェックの前に requireAuth は呼ばれる（未認証は形式によらず先に401で止める）
  it('IDの形式が不正なら404（DBへ投げない。500にしない）', async () => {
    const badContext = { params: Promise.resolve({ id: 'not-a-uuid' }) }
    const res = await GET(request(), badContext)
    expect(res.status).toBe(404)
    expect(mockGetCaseOrder).not.toHaveBeenCalled()
    expect(mockRequireAuth).toHaveBeenCalled()
  })

  // WHY: SPEC.md Part2「認可の形」の順序どおり、未認証者は ID の形式が不正でも
  //      404 ではなく 401 で止まる（認可のゲートを他のどの判定より先に通す）
  it('未認証かつIDの形式も不正なら401（形式より先に認証で止まる）', async () => {
    mockRequireAuth.mockRejectedValue(new Error('UNAUTHORIZED'))
    const badContext = { params: Promise.resolve({ id: 'not-a-uuid' }) }
    const res = await GET(request(), badContext)
    expect(res.status).toBe(401)
    expect(mockGetCaseOrder).not.toHaveBeenCalled()
  })

  it('見つからない（RLSで見えない・存在しない）なら404で、拒否をrecordHiddenRowDenialに残す', async () => {
    mockGetCaseOrder.mockResolvedValue(null)
    const res = await GET(request(), context)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('症例発注が見つかりません')
    expect(mockRecordHiddenRowDenial).toHaveBeenCalledWith({ table: 'case_orders', id: VALID_ID, actorId: 'u1' })
    expect(mockRequireFacilityAccess).not.toHaveBeenCalled()
  })

  it('見つかっても他施設（requireFacilityAccessが失敗）なら404（403にしない。存在を漏らさない）', async () => {
    mockGetCaseOrder.mockResolvedValue(CASE_ORDER)
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const res = await GET(request(), context)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('症例発注が見つかりません')
  })

  it('自施設のメンバーなら200で1件（ヘッダ+明細）を返す', async () => {
    mockGetCaseOrder.mockResolvedValue(CASE_ORDER)
    const res = await GET(request(), context)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ caseOrder: CASE_ORDER })
    expect(mockRequireFacilityAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'f1')
    expect(mockRecordHiddenRowDenial).not.toHaveBeenCalled()
  })

  // WHY: repository が投げた例外の本文（Supabaseの生エラー等）に患者の情報が入っていても、
  //      応答には出ない（repositoryError が ClientVisibleError 以外を汎用文言+500に畳む）ことを固定する
  it('repositoryが例外を投げたら500で、エラー本文の患者情報を応答に出さない', async () => {
    mockGetCaseOrder.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "case_orders_pkey" Detail: patient_id=(PT-SECRET-123) already exists')
    )
    const res = await GET(request(), context)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('症例発注の取得に失敗しました')
    expect(JSON.stringify(body)).not.toContain('PT-SECRET-123')
  })
})
