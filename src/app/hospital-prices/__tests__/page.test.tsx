import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import HospitalPricesPage from '../page'

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

const facilities = [
  { id: 'f1', name: 'テスト施設A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]
const prices = [
  {
    id: 'hp1',
    distributorProductId: 'dp1',
    facilityId: 'f1',
    purchasePrice: 1000,
    deliveryPrice: 1200,
    grossProfit: 200,
    purchaseRate: 0.5,
    deliveryRate: 0.6,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
]
const distributorProducts = [
  {
    id: 'dp1',
    productId: 'p1',
    maker: 'テストメーカー',
    supplier: 'テスト仕入先',
    name: 'テスト商品A',
    reimbursementPrice: 2000,
    quantity: 1,
    categoryId: 'c1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
]

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return {
    ok: init.status === undefined || init.status < 400,
    status: init.status ?? 200,
    json: async () => body,
  } as Response
}

describe('HospitalPricesPage', () => {
  beforeEach(() => {
    push.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('施設ID付きで病院価格一覧を取得する', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities }))
      if (url === '/api/hospital-prices?facilityId=f1') return Promise.resolve(jsonResponse({ prices }))
      if (url === '/api/distributor-products') return Promise.resolve(jsonResponse({ items: distributorProducts }))
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<HospitalPricesPage />)

    expect(await screen.findByText('テスト施設A')).toBeInTheDocument()
    expect(screen.getByText('テスト商品A')).toBeInTheDocument()
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/hospital-prices?facilityId=f1')
    })
    expect(fetchMock).not.toHaveBeenCalledWith('/api/hospital-prices')
  })
})
