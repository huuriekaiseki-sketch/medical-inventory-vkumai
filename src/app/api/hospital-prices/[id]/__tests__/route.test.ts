import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClientVisibleError } from '@/lib/client-visible-error'
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

// vi.mock は巻き上げられるので、factory から参照する値は vi.hoisted で先に定義する
const { CONFLICT_MESSAGE } = vi.hoisted(() => ({
  CONFLICT_MESSAGE: '他の利用者が先に更新または削除しました。最新の内容を読み込み直してから再度保存してください',
}))

vi.mock('@/lib/hospital-prices/repository', () => ({
  getHospitalPrice: (...args: unknown[]) => mockGetHospitalPrice(...args),
  updateHospitalPrice: (...args: unknown[]) => mockUpdateHospitalPrice(...args),
  deleteHospitalPrice: (...args: unknown[]) => mockDeleteHospitalPrice(...args),
  HOSPITAL_PRICE_CONFLICT_MESSAGE: CONFLICT_MESSAGE,
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

  // 約束カタログ（docs/agents/promise-catalog.md）: P-052 同一行の同時更新は競合側が拒否される
  it('楽観ロックの競合（他の利用者が先に更新）は 409 と区別できるメッセージを返す [P-052]', async () => {
    authenticated()
    mockGetHospitalPrice.mockResolvedValue({ id: 'hp1', ...validInput })
    // WHY(2026-09-11): 実物（repository.ts:104）は `ClientVisibleError` を投げるのに、
    //      ここだけ素の `Error` でモックしていた。**モックが実物より緩い**状態で、
    //      route を `instanceof ClientVisibleError` に締めたときに初めて露見した。
    //      モックは実物と同じ型を投げる（緩いモックは、締めた守りを素通りさせる）。
    mockUpdateHospitalPrice.mockRejectedValue(new ClientVisibleError(CONFLICT_MESSAGE))
    const staleInput = { ...validInput, expectedUpdatedAt: '2026-09-06T00:00:00.000000+00:00' }
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify(staleInput) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe(CONFLICT_MESSAGE)
    // expectedUpdatedAt はそのままリポジトリへ渡る（ここで落とすと楽観ロックが黙って無効になる）
    expect(mockUpdateHospitalPrice).toHaveBeenCalledWith(expect.anything(), 'hp1', expect.objectContaining({ expectedUpdatedAt: staleInput.expectedUpdatedAt }))
  })

  // WHY(C-022): 上のテストは `ClientVisibleError` を投げているので、**締めても締めなくても通る**。
  //      締めたことに意味があるかは、**翻訳済みでないエラーで同じ文言を投げて**初めて分かる。
  //      素の `Error` は分岐に入らず throw され、生の message が利用者へ出ない
  //      （Next.js 側で 500 になる。`toClientErrorMessage` を通る route ならそこでサニタイズされる）。
  it('翻訳済みでないエラー（素の Error）は、同じ文言でも生のまま返さない [C-022]', async () => {
    authenticated()
    mockGetHospitalPrice.mockResolvedValue({ id: 'hp1', ...validInput })
    mockUpdateHospitalPrice.mockRejectedValue(new Error('既に登録されています'))
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify(validInput) })

    await expect(PUT(req as never, context)).rejects.toThrow('既に登録されています')
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

// WHY(#757-24 の残り、2026-09-13): RLS で見えない行は 404 のままだが、存在するなら拒否として残す
const { mockRecordHiddenRowDenial } = vi.hoisted(() => ({ mockRecordHiddenRowDenial: vi.fn() }))
vi.mock('@/lib/security/hidden-row-denial', () => ({
  recordHiddenRowDenial: (...args: unknown[]) => mockRecordHiddenRowDenial(...args),
}))

describe('GET /api/hospital-prices/[id]: RLS で 0 件のとき [P-063]', () => {
  it('0 件なら 404 のまま、存在確認と記録のヘルパーを要求 ID と本人 ID で呼ぶ', async () => {
    authenticated()
    mockGetHospitalPrice.mockResolvedValue(null)
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(404)
    expect(mockRecordHiddenRowDenial).toHaveBeenCalledWith({ table: 'hospital_prices', id: 'hp1', actorId: 'u1' })
    expect(mockRequireFacilityAccess).not.toHaveBeenCalled()
  })

  it('見つかればヘルパーは呼ばず、所属判定へ進む', async () => {
    authenticated()
    mockGetHospitalPrice.mockResolvedValue({ id: 'hp1', facilityId: 'f1' })
    mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f1' })
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(200)
    expect(mockRecordHiddenRowDenial).not.toHaveBeenCalled()
  })
})
