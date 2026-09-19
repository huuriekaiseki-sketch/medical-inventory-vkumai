import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

const mockGetUser = vi.fn()
const mockRequireFacilityAccess = vi.fn()
const mockSearchLotItems = vi.fn()
const mockNormalizeLotInput = vi.fn((v: string) => v)

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/supabase/require-facility-access', () => ({
  requireFacilityAccess: (...args: unknown[]) => mockRequireFacilityAccess(...args),
}))

vi.mock('@/lib/lot-search/repository', () => ({
  searchLotItems: (...args: unknown[]) => mockSearchLotItems(...args),
}))

vi.mock('@/lib/lot-search/normalize', () => ({
  normalizeLotInput: (...args: [string]) => mockNormalizeLotInput(...args),
}))

const unauthenticated = () =>
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () =>
  mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockNormalizeLotInput.mockImplementation((v: string) => v)
  mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f1' })
  mockSearchLotItems.mockResolvedValue({ items: [], truncated: false })
})

describe('GET /api/facilities/[id]/lot-search（issue #803 P-013・P-015 の適用範囲）', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new NextRequest('http://localhost/api/facilities/f1/lot-search?lot=ABC'), makeContext('f1'))
    expect(res.status).toBe(401)
    expect(mockSearchLotItems).not.toHaveBeenCalled()
  })

  it('非メンバーの場合は403を返す', async () => {
    authenticated()
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const res = await GET(new NextRequest('http://localhost/api/facilities/f9/lot-search?lot=ABC'), makeContext('f9'))
    expect(res.status).toBe(403)
    expect(mockSearchLotItems).not.toHaveBeenCalled()
  })

  it('requireFacilityAccessにfacilityIdRequired:trueを渡す（admin横断の抜け道を塞ぐ）', async () => {
    authenticated()
    await GET(new NextRequest('http://localhost/api/facilities/f1/lot-search?lot=ABC'), makeContext('f1'))
    expect(mockRequireFacilityAccess).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'f1', { facilityIdRequired: true }
    )
  })

  it('lot未指定の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/facilities/f1/lot-search'), makeContext('f1'))
    expect(res.status).toBe(400)
    expect(mockSearchLotItems).not.toHaveBeenCalled()
  })

  it('lotが101字以上の場合は400を返す', async () => {
    authenticated()
    const longLot = 'A'.repeat(101)
    const res = await GET(new NextRequest(`http://localhost/api/facilities/f1/lot-search?lot=${longLot}`), makeContext('f1'))
    expect(res.status).toBe(400)
    expect(mockSearchLotItems).not.toHaveBeenCalled()
  })

  it('lotが1字の場合は200を返す（下限ちょうど）', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/facilities/f1/lot-search?lot=A'), makeContext('f1'))
    expect(res.status).toBe(200)
  })

  // WHY(レビュー指摘の修正): lotSearchQuerySchema が生の空白込み文字列の長さで min(1) を
  //      判定していたため、空白だけの入力（例: " "）が検証を通過し、後段の normalizeLotInput
  //      で空文字列に変わっていた。空文字列は ILIKE の "%%" として「lot が非 NULL の全行」に
  //      一致してしまうため、空白だけの入力は正規化を待たずスキーマの時点で 400 にする
  //      （lotSearchQuerySchema は空白より先に trim してから min/max を見るよう修正済み）。
  it('lotが空白のみの場合は400を返す（trim後に空になる入力を弾く）', async () => {
    authenticated()
    const res = await GET(
      new NextRequest('http://localhost/api/facilities/f1/lot-search?lot=%20%20%20'),
      makeContext('f1')
    )
    expect(res.status).toBe(400)
    expect(mockSearchLotItems).not.toHaveBeenCalled()
  })

  // WHY(レビュー指摘の修正で ' ABC ' → 'ABC' に変更): lotSearchQuerySchema が
  //      .trim() を .min()/.max() より先に適用するようになったため、parseQuery の時点で
  //      既に前後の空白が落ちている（' '  だけの入力を 400 にするための修正。詳細は
  //      schemas.ts の該当コメント参照）。normalizeLotInput にはその後の値が渡る。
  it('正常系: normalizeLotInputを通した値でsearchLotItemsを呼び、施設IDも渡す', async () => {
    authenticated()
    mockNormalizeLotInput.mockReturnValue('TRIMMED')
    mockSearchLotItems.mockResolvedValue({
      items: [{ kind: 'case_order', itemId: 'i1', parentId: 'p1', lot: 'TRIMMED', jan: '490001', quantity: 1, occurredAt: '2026-01-01T00:00:00Z' }],
      truncated: false,
    })
    const res = await GET(new NextRequest('http://localhost/api/facilities/f1/lot-search?lot=%20ABC%20'), makeContext('f1'))
    expect(res.status).toBe(200)
    expect(mockNormalizeLotInput).toHaveBeenCalledWith('ABC')
    expect(mockSearchLotItems).toHaveBeenCalledWith(expect.anything(), 'f1', 'TRIMMED')
    const body = await res.json()
    expect(body).toEqual({
      items: [{ kind: 'case_order', itemId: 'i1', parentId: 'p1', lot: 'TRIMMED', jan: '490001', quantity: 1, occurredAt: '2026-01-01T00:00:00Z' }],
      truncated: false,
    })
  })

  it('上限に当たった場合はtruncated:trueを返す', async () => {
    authenticated()
    mockSearchLotItems.mockResolvedValue({ items: [], truncated: true })
    const res = await GET(new NextRequest('http://localhost/api/facilities/f1/lot-search?lot=ABC'), makeContext('f1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.truncated).toBe(true)
  })

  // WHY(決定 6 を 2026-09-19 に (a)→(b) へ決め直した): 症例発注の行は患者 ID とイニシャルを持つ。
  //      **どの項目を出すかを決めるのは repository**（SELECT の列と型）で、そこは repository.test.ts と実 DB の統合テストが守る。
  //      このテストは searchLotItems をモックにしているので、ここで「患者が含まれない／含まれる」を見ても
  //      モックが返した値を見ているだけになる（最初の版はそうだった）。route について言えるのは
  //      「repository の結果に**足しも引きもしない**」ことなので、それを固定する
  it('repository が返した項目をそのまま返す（route は項目を足しも引きもしない）', async () => {
    authenticated()
    const items = [
      { kind: 'case_order', itemId: 'i1', parentId: 'p1', lot: 'ABC', jan: '490001', quantity: 1, occurredAt: '2026-01-02T00:00:00Z', patientId: 'P-0001', patientInitials: 'T.Y.' },
      { kind: 'loan_return', itemId: 'i2', parentId: 'p2', lot: 'ABC', jan: '490002', quantity: 2, occurredAt: '2026-01-01T00:00:00Z', cancelled: true },
    ]
    mockSearchLotItems.mockResolvedValue({ items, truncated: false })
    const res = await GET(new NextRequest('http://localhost/api/facilities/f1/lot-search?lot=ABC'), makeContext('f1'))
    const body = await res.json()
    expect(body).toEqual({ items, truncated: false })
  })

  // WHY: 一覧には患者 ID を出すと決めたが、**エラー応答とログには出さない**のは変わらない。
  //      PostgreSQL のエラー本文は行の中身を含みうる（`Failing row contains (...)`）ので、
  //      repository が投げたエラーの本文が応答へ素通りしないことを固定する
  it('repository のエラー本文に患者の情報が入っていても、エラー応答には出さない', async () => {
    authenticated()
    mockSearchLotItems.mockRejectedValue(new Error('Failing row contains (P-0001, T.Y., Dr. X)'))
    const res = await GET(new NextRequest('http://localhost/api/facilities/f1/lot-search?lot=ABC'), makeContext('f1'))
    expect(res.status).toBe(500)
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain('P-0001')
    expect(text).not.toContain('T.Y.')
    expect(text).not.toContain('Dr. X')
  })

  it('lotが2つ指定された場合は400を返す（パラメータ汚染防止）', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/facilities/f1/lot-search?lot=A&lot=B'), makeContext('f1'))
    expect(res.status).toBe(400)
    expect(mockSearchLotItems).not.toHaveBeenCalled()
  })

  it('例外発生時は500を返す', async () => {
    authenticated()
    mockSearchLotItems.mockRejectedValue(new Error('DB error'))
    const res = await GET(new NextRequest('http://localhost/api/facilities/f1/lot-search?lot=ABC'), makeContext('f1'))
    expect(res.status).toBe(500)
  })
})
