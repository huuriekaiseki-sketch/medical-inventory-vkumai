import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

import EditDistributorProductPage from '../page'

const products = [{ id: 'p1', jan: '4900000000001', ref: 'REF-1', createdAt: '', updatedAt: '' }]
const categories = [
  { id: 'c1', name: 'カテゴリA', description: null, createdAt: '', updatedAt: '' },
]
const item = {
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
}

// React 19 の use() は status/value を持つ thenable を同期的に解決する。
// テストでは解決済み thenable を渡して Suspense を回避する。
function params() {
  const p = Promise.resolve({ id: 'dp1' }) as Promise<{ id: string }> & {
    status?: string
    value?: { id: string }
  }
  p.status = 'fulfilled'
  p.value = { id: 'dp1' }
  return p
}

beforeEach(() => {
  pushMock.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

function setupFetch({ itemOk = true, putOk = true, putStatus = 200 } = {}) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      return Promise.resolve({ ok: putOk, status: putStatus, json: () => Promise.resolve({ error: '更新に失敗しました' }) })
    }
    if (url === '/api/distributor-products/dp1') {
      return Promise.resolve({ ok: itemOk, status: itemOk ? 200 : 404, json: () => Promise.resolve({ item: itemOk ? item : null }) })
    }
    if (url === '/api/products') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ products }) })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
  })
}

describe('EditDistributorProductPage', () => {
  it('item の値を defaultValues としてフォームに表示する', async () => {
    global.fetch = setupFetch() as unknown as typeof fetch
    render(<EditDistributorProductPage params={params()} />)
    expect(await screen.findByDisplayValue('商品A')).toBeInTheDocument()
    expect(screen.getByDisplayValue('メーカーA')).toBeInTheDocument()
    expect((screen.getByLabelText('カテゴリ') as HTMLSelectElement).value).toBe('c1')
  })

  it('更新成功で一覧へ遷移する', async () => {
    global.fetch = setupFetch({ putOk: true }) as unknown as typeof fetch
    render(<EditDistributorProductPage params={params()} />)
    await screen.findByDisplayValue('商品A')
    await userEvent.click(screen.getByRole('button', { name: '更新' }))
    expect(pushMock).toHaveBeenCalledWith('/distributor-products')
  })

  it('更新失敗で submitError を表示する', async () => {
    global.fetch = setupFetch({ putOk: false, putStatus: 500 }) as unknown as typeof fetch
    render(<EditDistributorProductPage params={params()} />)
    await screen.findByDisplayValue('商品A')
    await userEvent.click(screen.getByRole('button', { name: '更新' }))
    expect(await screen.findByText('更新に失敗しました')).toBeInTheDocument()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('item 取得失敗でエラーメッセージを表示する', async () => {
    global.fetch = setupFetch({ itemOk: false }) as unknown as typeof fetch
    render(<EditDistributorProductPage params={params()} />)
    expect(await screen.findByText('販売店商品の取得に失敗しました')).toBeInTheDocument()
  })

  it('「価格履歴を見る」リンクが正しい href を持つ', async () => {
    global.fetch = setupFetch() as unknown as typeof fetch
    render(<EditDistributorProductPage params={params()} />)
    await screen.findByDisplayValue('商品A')
    const link = screen.getByRole('link', { name: /価格履歴を見る/ })
    expect(link).toHaveAttribute('href', '/distributor-products/dp1/price-history')
  })
})
