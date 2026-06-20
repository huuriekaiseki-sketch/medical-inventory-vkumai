import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

import DistributorProductsPage from '../page'

const items = [
  {
    id: 'dp1',
    productId: 'p1',
    maker: 'メーカーA',
    supplier: '仕入先A',
    name: '商品A',
    reimbursementPrice: 1000,
    quantity: 10,
    categoryId: 'c1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
]
const categories = [
  { id: 'c1', name: 'カテゴリA', description: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]

function mockFetchOnce(handler: (url: string, init?: RequestInit) => unknown) {
  return vi.fn((url: string, init?: RequestInit) => {
    const result = handler(url, init)
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(result) })
  })
}

beforeEach(() => {
  pushMock.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('DistributorProductsPage', () => {
  it('items と categories を並列取得して一覧を表示する', async () => {
    global.fetch = mockFetchOnce((url) => {
      if (url === '/api/distributor-products') return { items }
      if (url === '/api/categories') return { categories }
      return {}
    }) as unknown as typeof fetch

    render(<DistributorProductsPage />)
    expect(await screen.findByText('商品A')).toBeInTheDocument()
    expect(screen.getByText('カテゴリA')).toBeInTheDocument()
  })

  it('新規登録ボタンで /distributor-products/new へ遷移', async () => {
    global.fetch = mockFetchOnce((url) => {
      if (url === '/api/distributor-products') return { items }
      if (url === '/api/categories') return { categories }
      return {}
    }) as unknown as typeof fetch

    render(<DistributorProductsPage />)
    await screen.findByText('商品A')
    await userEvent.click(screen.getByText('+ 新規登録'))
    expect(pushMock).toHaveBeenCalledWith('/distributor-products/new')
  })

  it('編集ボタンで edit ページへ遷移', async () => {
    global.fetch = mockFetchOnce((url) => {
      if (url === '/api/distributor-products') return { items }
      if (url === '/api/categories') return { categories }
      return {}
    }) as unknown as typeof fetch

    render(<DistributorProductsPage />)
    await screen.findByText('商品A')
    await userEvent.click(screen.getByText('編集'))
    expect(pushMock).toHaveBeenCalledWith('/distributor-products/dp1/edit')
  })

  it('削除確認OKで DELETE を呼ぶ', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
      if (url === '/api/distributor-products') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<DistributorProductsPage />)
    await screen.findByText('商品A')
    await userEvent.click(screen.getByText('削除'))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/distributor-products/dp1', { method: 'DELETE' })
    })
  })

  it('削除失敗時にエラーバナーを表示する', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: '削除に失敗しました' }) })
      if (url === '/api/distributor-products') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<DistributorProductsPage />)
    await screen.findByText('商品A')
    await userEvent.click(screen.getByText('削除'))
    expect(await screen.findByText('削除に失敗しました')).toBeInTheDocument()
  })
})
