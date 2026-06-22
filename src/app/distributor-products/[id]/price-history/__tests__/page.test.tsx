import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

import PriceHistoryPage from '../page'

// React 19 の use() は status/value を持つ thenable を同期的に解決する
function params(id = 'dp1') {
  const p = Promise.resolve({ id }) as Promise<{ id: string }> & {
    status?: string
    value?: { id: string }
  }
  p.status = 'fulfilled'
  p.value = { id }
  return p
}

const historyItems = [
  {
    id: 'h1',
    entityType: 'distributor_product' as const,
    entityId: 'dp1',
    distributorProductId: 'dp1',
    fieldName: 'reimbursement_price' as const,
    oldValue: 1000,
    newValue: 1200,
    changedAt: '2026-01-10T10:00:00Z',
    facilityName: null,
  },
]

beforeEach(() => {
  vi.restoreAllMocks()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('PriceHistoryPage', () => {
  it('ローディング中は「読み込み中...」を表示する', () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch
    render(<PriceHistoryPage params={params()} />)
    expect(screen.getByText('読み込み中...')).toBeInTheDocument()
  })

  it('履歴データを取得して PriceHistoryList を描画する', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: historyItems }),
      })
    ) as unknown as typeof fetch

    render(<PriceHistoryPage params={params()} />)
    // PriceHistoryList が空でないテーブルを描画する
    expect(await screen.findByRole('table')).toBeInTheDocument()
  })

  it('空の履歴の場合「変更履歴はありません」を表示する', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: [] }),
      })
    ) as unknown as typeof fetch

    render(<PriceHistoryPage params={params()} />)
    expect(await screen.findByText('変更履歴はありません')).toBeInTheDocument()
  })

  it('APIエラー時にエラーメッセージを表示する', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        json: () => Promise.resolve({}),
      })
    ) as unknown as typeof fetch

    render(<PriceHistoryPage params={params()} />)
    expect(await screen.findByText('履歴の取得に失敗しました')).toBeInTheDocument()
  })

  it('「編集に戻る」リンクが正しい href を持つ', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: [] }),
      })
    ) as unknown as typeof fetch

    render(<PriceHistoryPage params={params('dp42')} />)
    await screen.findByText('変更履歴はありません')
    const link = screen.getByRole('link', { name: /編集に戻る/ })
    expect(link).toHaveAttribute('href', '/distributor-products/dp42/edit')
  })
})
