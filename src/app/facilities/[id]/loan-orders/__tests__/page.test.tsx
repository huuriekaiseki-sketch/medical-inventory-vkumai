import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import LoanOrdersPage from '../page'

// WHY(issue #828): 取り消しの導線は短貸発注にも出る(OrderHistoryTable)のに、この一覧だけ
//      cancelled のラベルが無く、英字のまま画面に出ていた。症例発注(case-orders)では同じバグが
//      直っていたのに隣へ広げていなかった(C-047)。ここではラベルの表示だけを見る。

function params(id = 'f-1') {
  const p = Promise.resolve({ id }) as Promise<{ id: string }> & { status?: string; value?: { id: string } }
  p.status = 'fulfilled'
  p.value = { id }
  return p
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o-1',
    facilityId: 'f-1',
    procedureName: '虫垂切除術',
    maker: 'テストメーカー',
    status: 'submitted',
    items: [],
    createdAt: '2026-01-05T01:00:00Z',
    updatedAt: '2026-01-05T01:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('LoanOrdersPage', () => {
  it('cancelledは英字のままでなく「取り消し済」と表示する(issue #828)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ orders: [makeOrder({ status: 'cancelled' })] }))))
    render(<LoanOrdersPage params={params()} />)

    expect(await screen.findByText('取り消し済')).toBeInTheDocument()
    expect(screen.queryByText('cancelled')).not.toBeInTheDocument()
  })

  // WHY(対照): 上のテストが「一覧が描画されていない」ことで通っていないことを、同じ組み立てで確かめる
  it('submittedは「提出済」と表示する(対照)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ orders: [makeOrder({ status: 'submitted' })] }))))
    render(<LoanOrdersPage params={params()} />)

    expect(await screen.findByText('提出済')).toBeInTheDocument()
    expect(screen.queryByText('取り消し済')).not.toBeInTheDocument()
  })
})
