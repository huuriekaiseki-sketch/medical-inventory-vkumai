import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { PUT, PATCH, DELETE } from '../route'
import { ClientVisibleError } from '@/lib/client-visible-error'
import {
  CONSUMABLE_NOT_FOUND_ERROR,
  CONSUMABLE_ALREADY_RETIRED_ERROR,
  CONSUMABLE_IN_USE_ERROR,
} from '@/lib/consumables/repository'

const mockRequireAuth = vi.fn()
const mockRequireFacilityAccess = vi.fn()
const mockUpdateConsumable = vi.fn()
const mockRetireConsumable = vi.fn()
const mockDeleteConsumable = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({}),
}))
vi.mock('@/lib/supabase/require-auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}))
vi.mock('@/lib/supabase/require-facility-access', () => ({
  requireFacilityAccess: (...args: unknown[]) => mockRequireFacilityAccess(...args),
}))
vi.mock('@/lib/consumables/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/consumables/repository')>()
  return {
    ...actual,
    updateConsumable: (...args: unknown[]) => mockUpdateConsumable(...args),
    retireConsumable: (...args: unknown[]) => mockRetireConsumable(...args),
    deleteConsumable: (...args: unknown[]) => mockDeleteConsumable(...args),
  }
})

const FACILITY = '11111111-1111-4111-8111-111111111111'
const context = { params: Promise.resolve({ id: 'c-1' }) }
const consumable = { id: 'c-1', facilityId: FACILITY, name: '品名', purpose: '用途', status: 'active', inUse: false }

function jsonRequest(method: string, body: unknown) {
  return new NextRequest('http://localhost/api/consumables/c-1', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function deleteRequest(query = `?facilityId=${FACILITY}`) {
  return new NextRequest(`http://localhost/api/consumables/c-1${query}`, { method: 'DELETE' })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAuth.mockResolvedValue({ id: 'u1' })
  mockRequireFacilityAccess.mockResolvedValue(FACILITY)
})

// WHY(2026-09-09): 消耗品は**作成と一覧しかできなかった**のに、DB は施設の writer に
//      UPDATE / DELETE を許していた（層の食い違い、E-055 の裏返し）。
//      足した 3 つの道について、認可・入口の検証・失敗の写し方を固定する。
describe('PUT /api/consumables/[id]（名前・用途・JAN を直す）', () => {
  it('直せたら 200 で消耗品を返す', async () => {
    mockUpdateConsumable.mockResolvedValue(consumable)
    const res = await PUT(jsonRequest('PUT', { facilityId: FACILITY, name: '品名', purpose: '用途' }), context)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ consumable })
    expect(mockUpdateConsumable).toHaveBeenCalledWith(expect.anything(), FACILITY, 'c-1', {
      name: '品名',
      jan: undefined,
      purpose: '用途',
    })
  })

  // WHY: 作成と同じ `consumableInputSchema` を通す。直す側だけ緩い、という食い違いを作らない
  it('品名が空白のみなら 400 で、repository を呼ばない', async () => {
    const res = await PUT(jsonRequest('PUT', { facilityId: FACILITY, name: '   ', purpose: '用途' }), context)
    expect(res.status).toBe(400)
    expect(mockUpdateConsumable).not.toHaveBeenCalled()
  })

  it('未認証なら 401 で、repository を呼ばない', async () => {
    mockRequireAuth.mockRejectedValue(new Error('UNAUTHENTICATED'))
    const res = await PUT(jsonRequest('PUT', { facilityId: FACILITY, name: '品名', purpose: '用途' }), context)
    expect(res.status).toBe(401)
    expect(mockUpdateConsumable).not.toHaveBeenCalled()
  })

  it('他施設なら 403 で、repository を呼ばない', async () => {
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const res = await PUT(jsonRequest('PUT', { facilityId: FACILITY, name: '品名', purpose: '用途' }), context)
    expect(res.status).toBe(403)
    expect(mockUpdateConsumable).not.toHaveBeenCalled()
  })

  // WHY(404 と 400 を分ける): 「無い」と「入力が悪い」は利用者にとって別の話
  it('見つからなければ 404', async () => {
    mockUpdateConsumable.mockRejectedValue(new ClientVisibleError(CONSUMABLE_NOT_FOUND_ERROR))
    const res = await PUT(jsonRequest('PUT', { facilityId: FACILITY, name: '品名', purpose: '用途' }), context)
    expect(res.status).toBe(404)
  })

  it('存在しない JAN なら 400（作成と同じ FK 違反の写し方）', async () => {
    mockUpdateConsumable.mockRejectedValue(new ClientVisibleError('指定されたJANコードの製品が見つかりません'))
    const res = await PUT(jsonRequest('PUT', { facilityId: FACILITY, name: '品名', purpose: '用途', jan: '999' }), context)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('指定されたJANコードの製品が見つかりません')
  })
})

describe('PATCH /api/consumables/[id]（使用停止）', () => {
  it('止められたら 200 で消耗品を返す', async () => {
    mockRetireConsumable.mockResolvedValue({ ...consumable, status: 'retired' })
    const res = await PATCH(jsonRequest('PATCH', { facilityId: FACILITY, action: 'retire' }), context)
    expect(res.status).toBe(200)
    expect(mockRetireConsumable).toHaveBeenCalledWith(expect.anything(), FACILITY, 'c-1')
  })

  // WHY: action を literal にしてあるので、状態を自由に入れる PATCH にはならない。
  //      **戻す道は入口の形からして無い**（DB のトリガーも `retired` からの遷移を拒む）
  it('action が retire 以外なら 400 で、repository を呼ばない', async () => {
    const res = await PATCH(jsonRequest('PATCH', { facilityId: FACILITY, action: 'active' }), context)
    expect(res.status).toBe(400)
    expect(mockRetireConsumable).not.toHaveBeenCalled()
  })

  it('未認証なら 401 で、repository を呼ばない', async () => {
    mockRequireAuth.mockRejectedValue(new Error('UNAUTHENTICATED'))
    const res = await PATCH(jsonRequest('PATCH', { facilityId: FACILITY, action: 'retire' }), context)
    expect(res.status).toBe(401)
    expect(mockRetireConsumable).not.toHaveBeenCalled()
  })

  it('他施設なら 403 で、repository を呼ばない', async () => {
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const res = await PATCH(jsonRequest('PATCH', { facilityId: FACILITY, action: 'retire' }), context)
    expect(res.status).toBe(403)
    expect(mockRetireConsumable).not.toHaveBeenCalled()
  })

  it('見つからなければ 404', async () => {
    mockRetireConsumable.mockRejectedValue(new ClientVisibleError(CONSUMABLE_NOT_FOUND_ERROR))
    const res = await PATCH(jsonRequest('PATCH', { facilityId: FACILITY, action: 'retire' }), context)
    expect(res.status).toBe(404)
  })

  it('すでに止まっていれば 409', async () => {
    mockRetireConsumable.mockRejectedValue(new ClientVisibleError(CONSUMABLE_ALREADY_RETIRED_ERROR))
    const res = await PATCH(jsonRequest('PATCH', { facilityId: FACILITY, action: 'retire' }), context)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe(CONSUMABLE_ALREADY_RETIRED_ERROR)
  })
})

describe('DELETE /api/consumables/[id]（発注実績が無いものだけ消す）', () => {
  it('消せたら 200', async () => {
    mockDeleteConsumable.mockResolvedValue(undefined)
    const res = await DELETE(deleteRequest(), context)
    expect(res.status).toBe(200)
    expect(mockDeleteConsumable).toHaveBeenCalledWith(expect.anything(), FACILITY, 'c-1')
  })

  it('施設 ID が無ければ 400 で、repository を呼ばない', async () => {
    mockRequireFacilityAccess.mockRejectedValue(new Error('FACILITY_ID_REQUIRED'))
    const res = await DELETE(deleteRequest(''), context)
    expect(res.status).toBe(400)
    expect(mockDeleteConsumable).not.toHaveBeenCalled()
  })

  it('未認証なら 401 で、repository を呼ばない', async () => {
    mockRequireAuth.mockRejectedValue(new Error('UNAUTHENTICATED'))
    const res = await DELETE(deleteRequest(), context)
    expect(res.status).toBe(401)
    expect(mockDeleteConsumable).not.toHaveBeenCalled()
  })

  it('他施設なら 403 で、repository を呼ばない', async () => {
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const res = await DELETE(deleteRequest(), context)
    expect(res.status).toBe(403)
    expect(mockDeleteConsumable).not.toHaveBeenCalled()
  })

  it('見つからなければ 404', async () => {
    mockDeleteConsumable.mockRejectedValue(new ClientVisibleError(CONSUMABLE_NOT_FOUND_ERROR))
    const res = await DELETE(deleteRequest(), context)
    expect(res.status).toBe(404)
  })

  // WHY(409 に写す): 発注で使われていれば消せない。**直し方のある拒否**なので、
  //      「使用停止にしてください」と道を示す本文をそのまま返す
  it('発注で使われていれば 409 で、使用停止を案内する', async () => {
    mockDeleteConsumable.mockRejectedValue(new ClientVisibleError(CONSUMABLE_IN_USE_ERROR))
    const res = await DELETE(deleteRequest(), context)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe(CONSUMABLE_IN_USE_ERROR)
  })
})
