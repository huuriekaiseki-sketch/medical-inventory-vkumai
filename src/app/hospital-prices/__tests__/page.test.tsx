import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HospitalPricesPage from '../page'

const push = vi.fn()
const replace = vi.fn()
let currentSearchParams = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => currentSearchParams,
}))

const facilities = [
  { id: 'f1', name: 'テスト施設A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'f2', name: 'テスト施設B', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
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
const pricesF2 = [
  {
    id: 'hp2',
    distributorProductId: 'dp1',
    facilityId: 'f2',
    purchasePrice: 2000,
    deliveryPrice: 2200,
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

function mockFetch({
  facilities: fac,
  pricesByFacility,
}: {
  facilities: typeof facilities
  pricesByFacility: Record<string, unknown[]>
}) {
  return vi.fn((url: string) => {
    if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities: fac }))
    if (url === '/api/distributor-products') return Promise.resolve(jsonResponse({ items: distributorProducts }))
    const match = url.match(/^\/api\/hospital-prices\?facilityId=(.+)$/)
    if (match) {
      const facilityId = decodeURIComponent(match[1])
      return Promise.resolve(jsonResponse({ prices: pricesByFacility[facilityId] ?? [] }))
    }
    return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
  })
}

describe('HospitalPricesPage', () => {
  beforeEach(() => {
    push.mockReset()
    replace.mockReset()
    currentSearchParams = new URLSearchParams()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('施設ID付きで病院価格一覧を取得する', async () => {
    const fetchMock = mockFetch({
      facilities: [facilities[0]],
      pricesByFacility: { f1: prices },
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<HospitalPricesPage />)

    expect(await screen.findByText('テスト商品A')).toBeInTheDocument()
    expect(screen.getAllByText('テスト施設A').length).toBeGreaterThan(0)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/hospital-prices?facilityId=f1')
    })
    expect(fetchMock).not.toHaveBeenCalledWith('/api/hospital-prices')
  })

  it('複数施設が返る場合、プルダウンに全施設が選択肢として表示される', async () => {
    const fetchMock = mockFetch({
      facilities,
      pricesByFacility: { f1: prices, f2: pricesF2 },
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<HospitalPricesPage />)

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument()
    })
    expect(screen.getByRole('option', { name: 'テスト施設A' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'テスト施設B' })).toBeInTheDocument()
  })

  it('URLにfacilityIdが無い場合、施設名昇順の先頭施設が初期選択される', async () => {
    const fetchMock = mockFetch({
      facilities,
      pricesByFacility: { f1: prices, f2: pricesF2 },
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<HospitalPricesPage />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/hospital-prices?facilityId=f1')
    })
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('f1')
  })

  it('URLに有効なfacilityIdがある場合、その施設が初期選択される', async () => {
    currentSearchParams = new URLSearchParams('facilityId=f2')
    const fetchMock = mockFetch({
      facilities,
      pricesByFacility: { f1: prices, f2: pricesF2 },
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<HospitalPricesPage />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/hospital-prices?facilityId=f2')
    })
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('f2')
  })

  it('URLに不正・アクセス不可なfacilityIdがある場合、先頭施設にフォールバックする', async () => {
    currentSearchParams = new URLSearchParams('facilityId=invalid-id')
    const fetchMock = mockFetch({
      facilities,
      pricesByFacility: { f1: prices, f2: pricesF2 },
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<HospitalPricesPage />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/hospital-prices?facilityId=f1')
    })
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/hospital-prices?facilityId=f1')
    })
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('f1')
  })

  it('プルダウンで施設を切り替えると価格一覧が切り替わり、URLも更新される', async () => {
    const fetchMock = mockFetch({
      facilities,
      pricesByFacility: { f1: prices, f2: pricesF2 },
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<HospitalPricesPage />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/hospital-prices?facilityId=f1')
    })
    const select = screen.getByRole('combobox') as HTMLSelectElement
    await user.selectOptions(select, 'f2')

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/hospital-prices?facilityId=f2')
    })
  })

  it('施設が0件の場合、プルダウンが空・価格一覧も空で表示される', async () => {
    const fetchMock = mockFetch({
      facilities: [],
      pricesByFacility: {},
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<HospitalPricesPage />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/facilities')
    })
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/^\/api\/hospital-prices/))
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.children.length).toBe(0)
  })

  it('削除でfetchが例外を投げた場合もエラーバナーを表示する', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.reject(new Error('network error'))
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities: [facilities[0]] }))
      if (url === '/api/distributor-products') return Promise.resolve(jsonResponse({ items: distributorProducts }))
      const match = url.match(/^\/api\/hospital-prices\?facilityId=(.+)$/)
      if (match) return Promise.resolve(jsonResponse({ prices }))
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<HospitalPricesPage />)
    await screen.findByText('テスト商品A')

    await userEvent.click(screen.getAllByRole('button', { name: '削除' })[0])

    expect(await screen.findByText('削除に失敗しました')).toBeInTheDocument()
  })
})
