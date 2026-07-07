import { vi, describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/supabase/require-auth', () => ({ requireAuth: vi.fn().mockResolvedValue({ id: 'u-1', email: 'user@example.com' }) }))
vi.mock('@/lib/supabase/require-facility-access', () => ({
  requireFacilityAccess: vi.fn().mockImplementation(async (_db: unknown, _user: unknown, fid: string | null) => {
    if (!fid) throw new Error('FACILITY_ID_REQUIRED')
    return { facilityId: fid }
  }),
}))
vi.mock('@/lib/hospital-prices/repository')

import { listHospitalPrices, createHospitalPrice } from '@/lib/hospital-prices/repository'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { GET, POST } from '@/app/api/hospital-prices/route'

const mockPrice = {
  id: 'p-1',
  distributorProductId: 'dp-1',
  facilityId: 'f-1',
  purchasePrice: 1000,
  deliveryPrice: 100,
  grossProfit: 900,
  purchaseRate: 0.5,
  deliveryRate: 0.05,
  createdAt: '2026-06-29T00:00:00Z',
  updatedAt: '2026-06-29T00:00:00Z',
}

function makeRequest(url: string, init?: Omit<RequestInit, 'signal'> & { signal?: AbortSignal }) {
  return new NextRequest(`http://localhost${url}`, init)
}

beforeEach(() => {
  vi.resetAllMocks()
  // resetAllMocksはvi.mockのトップレベル実装も消すため、db・認証のモックをここで復元する
  vi.mocked(createServerSupabase).mockResolvedValue({} as Awaited<ReturnType<typeof createServerSupabase>>)
  vi.mocked(requireAuth).mockResolvedValue({ id: 'u-1', email: 'user@example.com' } as Awaited<ReturnType<typeof requireAuth>>)
  vi.mocked(requireFacilityAccess).mockImplementation(async (_db, _user, fid) => {
    if (!fid) throw new Error('FACILITY_ID_REQUIRED')
    return { facilityId: fid }
  })
})

describe('GET /api/hospital-prices', () => {
  it('一覧取得成功（200）', async () => {
    vi.mocked(listHospitalPrices).mockResolvedValue([mockPrice])
    const req = makeRequest('/api/hospital-prices?facilityId=f-1')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.prices).toHaveLength(1)
    expect(body.prices[0].id).toBe('p-1')
    // facilityIdは認可チェックだけでなくクエリの絞り込みにも使う
    expect(listHospitalPrices).toHaveBeenCalledWith(expect.anything(), 'f-1')
  })

  it('admin が facilityId 未指定なら全件取得（フィルタなし）', async () => {
    vi.mocked(requireFacilityAccess).mockResolvedValueOnce({ facilityId: null })
    vi.mocked(listHospitalPrices).mockResolvedValue([mockPrice])
    const req = makeRequest('/api/hospital-prices')
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(listHospitalPrices).toHaveBeenCalledWith(expect.anything(), null)
  })

  it('未認証（401）', async () => {
    vi.mocked(requireAuth).mockRejectedValueOnce(new Error('UNAUTHORIZED'))
    const req = makeRequest('/api/hospital-prices?facilityId=f-1')
    const res = await GET(req)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('認証が必要です')
  })

  it('facilityId 未指定（400）', async () => {
    const req = makeRequest('/api/hospital-prices')
    const res = await GET(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('facilityId は必須です')
  })

  it('施設アクセス拒否（403）', async () => {
    vi.mocked(requireFacilityAccess).mockRejectedValueOnce(new Error('FORBIDDEN'))
    const req = makeRequest('/api/hospital-prices?facilityId=f-2')
    const res = await GET(req)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('アクセス権限がありません')
  })
})

describe('POST /api/hospital-prices', () => {
  it('正常作成（201）', async () => {
    vi.mocked(createHospitalPrice).mockResolvedValue(mockPrice)
    const req = makeRequest('/api/hospital-prices', {
      method: 'POST',
      body: JSON.stringify({
        distributorProductId: 'dp-1',
        facilityId: 'f-1',
        purchasePrice: 1000,
        deliveryPrice: 100,
      }),
    })
    const res = await POST(req)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.price.id).toBe('p-1')
  })

  it('未認証（401）', async () => {
    vi.mocked(requireAuth).mockRejectedValueOnce(new Error('UNAUTHORIZED'))
    const req = makeRequest('/api/hospital-prices', {
      method: 'POST',
      body: JSON.stringify({
        distributorProductId: 'dp-1',
        facilityId: 'f-1',
        purchasePrice: 1000,
        deliveryPrice: 100,
      }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('認証が必要です')
  })

  it('施設アクセス拒否（403）', async () => {
    vi.mocked(requireFacilityAccess).mockRejectedValueOnce(new Error('FORBIDDEN'))
    const req = makeRequest('/api/hospital-prices', {
      method: 'POST',
      body: JSON.stringify({
        distributorProductId: 'dp-1',
        facilityId: 'f-2',
        purchasePrice: 1000,
        deliveryPrice: 100,
      }),
    })
    const res = await POST(req)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('アクセス権限がありません')
  })

  it('必須項目未入力（400）', async () => {
    const req = makeRequest('/api/hospital-prices', {
      method: 'POST',
      body: JSON.stringify({
        distributorProductId: 'dp-1',
        facilityId: 'f-1',
        purchasePrice: 1000,
        // deliveryPrice missing
      }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('必須項目が未入力です')
  })
})
