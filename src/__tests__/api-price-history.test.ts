import { vi, describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))
vi.mock('@/lib/price-histories/repository')
vi.mock('@/lib/distributor-products/repository')

import { getPriceHistory } from '@/lib/price-histories/repository'
import { getDistributorProduct } from '@/lib/distributor-products/repository'
import { GET } from '@/app/api/distributor-products/[id]/price-history/route'

const mockHistory = {
  id: 'hist-1',
  entityType: 'distributor_product' as const,
  entityId: 'dp-1',
  distributorProductId: 'dp-1',
  fieldName: 'reimbursement_price' as const,
  oldValue: 1000,
  newValue: 1200,
  changedAt: '2026-06-22T10:00:00Z',
  facilityName: null,
}

const mockProduct = {
  id: 'dp-1',
  productId: 'prod-1',
  maker: 'メーカーA',
  supplier: '仕入先A',
  name: '商品A',
  reimbursementPrice: 1200,
  quantity: 1,
  categoryId: 'cat-1',
  createdAt: '2026-06-22T00:00:00Z',
  updatedAt: '2026-06-22T00:00:00Z',
}

function makeRequest(url: string) {
  return new NextRequest(`http://localhost${url}`)
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => vi.resetAllMocks())

describe('GET /api/distributor-products/[id]/price-history', () => {
  it('価格履歴一覧を返す', async () => {
    vi.mocked(getDistributorProduct).mockResolvedValue(mockProduct)
    vi.mocked(getPriceHistory).mockResolvedValue([mockHistory])

    const req = makeRequest('/api/distributor-products/dp-1/price-history')
    const res = await GET(req, makeParams('dp-1'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].fieldName).toBe('reimbursement_price')
    expect(body.items[0].oldValue).toBe(1000)
  })

  it('distributor_product が存在しない場合 404 を返す', async () => {
    vi.mocked(getDistributorProduct).mockResolvedValue(null)

    const req = makeRequest('/api/distributor-products/nonexistent/price-history')
    const res = await GET(req, makeParams('nonexistent'))

    expect(res.status).toBe(404)
  })

  it('履歴が 0 件のとき空配列を返す', async () => {
    vi.mocked(getDistributorProduct).mockResolvedValue(mockProduct)
    vi.mocked(getPriceHistory).mockResolvedValue([])

    const req = makeRequest('/api/distributor-products/dp-1/price-history')
    const res = await GET(req, makeParams('dp-1'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(0)
  })

  it('リポジトリがエラーを投げた場合 500 を返す', async () => {
    vi.mocked(getDistributorProduct).mockResolvedValue(mockProduct)
    vi.mocked(getPriceHistory).mockRejectedValue(new Error('DB error'))

    const req = makeRequest('/api/distributor-products/dp-1/price-history')
    const res = await GET(req, makeParams('dp-1'))

    expect(res.status).toBe(500)
  })
})
