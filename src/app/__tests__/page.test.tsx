import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import Home from '../page'
import type { DashboardData } from '@/types/dashboard'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const dashboardData: DashboardData = {
  facilitySummaries: [
    {
      facilityId: 'f1',
      facilityName: '中央病院',
      caseOrderCount: 2,
      caseOrderLatestAt: '2026-06-01T00:00:00Z',
      consumableOrderCount: 0,
      consumableOrderLatestAt: null,
      loanOrderCount: 1,
      loanOrderLatestAt: '2026-06-02T00:00:00Z',
    },
  ],
  loanOutstanding: [{ facilityId: 'f1', facilityName: '中央病院', outstandingCount: 2 }],
  recentPriceChanges: [
    {
      id: 'h1',
      entityType: 'distributor_product',
      entityId: 'dp1',
      distributorProductId: 'dp1',
      fieldName: 'reimbursement_price',
      oldValue: 1000,
      newValue: 1200,
      changedAt: '2026-06-02T00:00:00Z',
      productName: '製品A',
    },
  ],
  isAdmin: false,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Home (dashboard page)', () => {
  it('取得中はローディング表示になる', () => {
    global.fetch = vi.fn().mockImplementation(() => new Promise(() => {})) as unknown as typeof fetch
    render(<Home />)
    expect(screen.getByText('読み込み中...')).toBeInTheDocument()
  })

  it('正常系: ダッシュボードデータが表示される', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(dashboardData),
    }) as unknown as typeof fetch
    render(<Home />)
    await screen.findByText('中央病院')
    expect(screen.getByText('未返却 2件')).toBeInTheDocument()
    expect(screen.getByText('製品A')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /施設一覧/ })).toBeInTheDocument()
  })

  it('空状態: 各セクションが「データがありません」になる', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          facilitySummaries: [],
          loanOutstanding: [],
          recentPriceChanges: [],
          isAdmin: false,
        }),
    }) as unknown as typeof fetch
    render(<Home />)
    await waitFor(() => expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument())
    expect(screen.getAllByText('データがありません').length).toBeGreaterThanOrEqual(2)
  })

  it('fetch失敗時にエラーメッセージが表示される', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: 'NG' }) }) as unknown as typeof fetch
    render(<Home />)
    await screen.findByText('ダッシュボードの取得に失敗しました')
  })
})
