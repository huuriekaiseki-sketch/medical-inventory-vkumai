import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, PUT, DELETE } from '../route'

const mockGetUser = vi.fn()
const mockGetHospitalPrice = vi.fn()
const mockUpdateHospitalPrice = vi.fn()
const mockDeleteHospitalPrice = vi.fn()
const mockRequireFacilityAccess = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/hospital-prices/repository', () => ({
  getHospitalPrice: (...args: unknown[]) => mockGetHospitalPrice(...args),
  updateHospitalPrice: (...args: unknown[]) => mockUpdateHospitalPrice(...args),
  deleteHospitalPrice: (...args: unknown[]) => mockDeleteHospitalPrice(...args),
}))

vi.mock('@/lib/supabase/require-facility-access', () => ({
  requireFacilityAccess: (...args: unknown[]) => mockRequireFacilityAccess(...args),
}))

const context = { params: Promise.resolve({ id: 'hp1' }) }
const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

const validInput = { distributorProductId: 'dp1', facilityId: 'f1', purchasePrice: 100, deliveryPrice: 150 }

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f1' })
})

describe('GET /api/hospital-prices/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(401)
    expect(mockGetHospitalPrice).not.toHaveBeenCalled()
  })

  it('他施設のデータにはアクセスできない(403)', async () => {
    authenticated()
    mockGetHospitalPrice.mockResolvedValue({ id: 'hp1', ...validInput })
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(403)
  })

  it('認証済み・アクセス権ありで正常に取得できる', async () => {
    authenticated()
    mockGetHospitalPrice.mockResolvedValue({ id: 'hp1', ...validInput })
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(200)
    expect(mockRequireFacilityAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'f1')
  })
})

describe('PUT /api/hospital-prices/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify(validInput) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(401)
    expect(mockUpdateHospitalPrice).not.toHaveBeenCalled()
  })

  it('対象レコードが存在しない場合は404を返す', async () => {
    authenticated()
    mockGetHospitalPrice.mockResolvedValue(null)
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify(validInput) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(404)
    expect(mockUpdateHospitalPrice).not.toHaveBeenCalled()
  })

  it('他施設のデータにはアクセスできない(403)', async () => {
    authenticated()
    mockGetHospitalPrice.mockResolvedValue({ id: 'hp1', ...validInput })
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify(validInput) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(403)
    expect(mockUpdateHospitalPrice).not.toHaveBeenCalled()
  })

  it('既存レコードの実facilityIdに対してアクセス権チェックを行う（body.facilityIdの詐称を許さない）', async () => {
    authenticated()
    // 既存レコードは施設f1所有。攻撃者は自分が所属するf9をbodyに詰めて送るが、
    // 実施設f1へのアクセス権がないため拒否されるべき
    mockGetHospitalPrice.mockResolvedValue({ id: 'hp1', ...validInput })
    mockRequireFacilityAccess.mockImplementation(async (_db, _user, facilityId) => {
      if (facilityId === 'f1') throw new Error('FORBIDDEN')
      return { facilityId }
    })
    const spoofedInput = { ...validInput, facilityId: 'f9' }
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify(spoofedInput) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(403)
    expect(mockRequireFacilityAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'f1')
    expect(mockUpdateHospitalPrice).not.toHaveBeenCalled()
  })

  it('施設付け替え（facilityId変更）は移動元・移動先の両方にアクセス権が必要', async () => {
    authenticated()
    mockGetHospitalPrice.mockResolvedValue({ id: 'hp1', ...validInput })
    mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f2' })
    mockUpdateHospitalPrice.mockResolvedValue({ id: 'hp1', ...validInput, facilityId: 'f2' })
    const movedInput = { ...validInput, facilityId: 'f2' }
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify(movedInput) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(200)
    expect(mockRequireFacilityAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'f1')
    expect(mockRequireFacilityAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'f2')
  })

  it('認証済み・アクセス権ありで正常に更新できる（facilityId変更なし）', async () => {
    authenticated()
    mockGetHospitalPrice.mockResolvedValue({ id: 'hp1', ...validInput })
    mockUpdateHospitalPrice.mockResolvedValue({ id: 'hp1', ...validInput })
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify(validInput) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(200)
    expect(mockRequireFacilityAccess).toHaveBeenCalledTimes(1)
    expect(mockRequireFacilityAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'f1')
  })
})

describe('DELETE /api/hospital-prices/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await DELETE(new Request('http://localhost') as never, context)
    expect(res.status).toBe(401)
    expect(mockDeleteHospitalPrice).not.toHaveBeenCalled()
  })

  it('他施設のデータにはアクセスできない(403)', async () => {
    authenticated()
    mockGetHospitalPrice.mockResolvedValue({ id: 'hp1', ...validInput })
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const res = await DELETE(new Request('http://localhost') as never, context)
    expect(res.status).toBe(403)
    expect(mockDeleteHospitalPrice).not.toHaveBeenCalled()
  })

  it('認証済み・アクセス権ありで正常に削除できる', async () => {
    authenticated()
    mockGetHospitalPrice.mockResolvedValue({ id: 'hp1', ...validInput })
    mockDeleteHospitalPrice.mockResolvedValue(undefined)
    const res = await DELETE(new Request('http://localhost') as never, context)
    expect(res.status).toBe(200)
    expect(mockRequireFacilityAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'f1')
  })
})
