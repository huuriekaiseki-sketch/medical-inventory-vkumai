import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OrderHistoryTable } from '../OrderHistoryTable'
import type { OrderListItem } from '@/types/order'

function makeItem(overrides: Partial<OrderListItem> = {}): OrderListItem {
  return {
    id: 'o-1',
    kind: 'case_order',
    facilityId: 'f-1',
    status: 'draft',
    summary: '虫垂切除術',
    createdAt: '2026-07-10T00:00:00Z',
    ...overrides,
  }
}

describe('OrderHistoryTable', () => {
  it('種別バッジ・概要・ステータス・作成日を表示する', () => {
    render(<OrderHistoryTable items={[makeItem()]} />)

    expect(screen.getByText('症例発注')).toBeInTheDocument()
    expect(screen.getByText('虫垂切除術')).toBeInTheDocument()
    expect(screen.getByText('下書き')).toBeInTheDocument()
    expect(screen.getByText('2026/7/10', { exact: false })).toBeInTheDocument()
  })

  it('種別ごとにバッジラベルが正しい', () => {
    render(
      <OrderHistoryTable
        items={[
          makeItem({ id: 'o-1', kind: 'case_order' }),
          makeItem({ id: 'o-2', kind: 'consumable_order' }),
          makeItem({ id: 'o-3', kind: 'loan_order' }),
          makeItem({ id: 'o-4', kind: 'loan_return' }),
        ]}
      />
    )

    expect(screen.getByText('症例発注')).toBeInTheDocument()
    expect(screen.getByText('消耗品発注')).toBeInTheDocument()
    expect(screen.getByText('短貸発注')).toBeInTheDocument()
    expect(screen.getByText('短貸返却')).toBeInTheDocument()
  })

  it('submitted は提出済、returned は返却済と表示される', () => {
    render(
      <OrderHistoryTable
        items={[
          makeItem({ id: 'o-1', status: 'submitted' }),
          makeItem({ id: 'o-2', kind: 'loan_return', status: 'returned' }),
        ]}
      />
    )

    expect(screen.getByText('提出済')).toBeInTheDocument()
    expect(screen.getByText('返却済')).toBeInTheDocument()
  })

  it('unreturned: true の短貸発注行に「未返却」バッジが表示される', () => {
    render(
      <OrderHistoryTable
        items={[makeItem({ id: 'o-1', kind: 'loan_order', status: 'submitted', unreturned: true })]}
      />
    )

    expect(screen.getByText('未返却')).toBeInTheDocument()
  })

  it('unreturned: false / undefined の行には「未返却」バッジが表示されない', () => {
    render(
      <OrderHistoryTable
        items={[
          makeItem({ id: 'o-1', kind: 'loan_order', status: 'submitted', unreturned: false }),
          makeItem({ id: 'o-2', kind: 'loan_order', status: 'draft' }),
        ]}
      />
    )

    expect(screen.queryByText('未返却')).not.toBeInTheDocument()
  })

  it('未知のstatus値はそのまま表示する（フォールバック）', () => {
    render(<OrderHistoryTable items={[makeItem({ status: 'weird' })]} />)
    expect(screen.getByText('weird')).toBeInTheDocument()
  })

  it('モバイル幅でも水平スクロールできるようoverflow-x-autoでラップされる', () => {
    const { container } = render(<OrderHistoryTable items={[makeItem()]} />)
    expect(container.querySelector('.overflow-x-auto')).not.toBeNull()
  })

  // WHY(issue #809 決定C=(3)): /orders は施設別一覧(最新50件)より古い記録も含む唯一の入口。
  //      症例発注・短貸返却の行には詳細ページへのリンクを出す(item.facilityIdを使う)。
  it('症例発注・短貸返却の行には詳細ページへのリンクを出す(item.facilityIdを使う)', () => {
    render(
      <OrderHistoryTable
        items={[
          makeItem({ id: 'o-1', kind: 'case_order', facilityId: 'f-9' }),
          makeItem({ id: 'o-2', kind: 'loan_return', facilityId: 'f-9' }),
        ]}
      />
    )

    expect(screen.getAllByRole('link', { name: '詳細を見る' })[0]).toHaveAttribute(
      'href',
      '/facilities/f-9/case-orders/o-1'
    )
    expect(screen.getAllByRole('link', { name: '詳細を見る' })[1]).toHaveAttribute(
      'href',
      '/facilities/f-9/loan-returns/o-2'
    )
  })

  it('消耗品発注・短貸発注の行には詳細リンクを出さない(対象外)', () => {
    render(
      <OrderHistoryTable
        items={[
          makeItem({ id: 'o-3', kind: 'consumable_order' }),
          makeItem({ id: 'o-4', kind: 'loan_order' }),
        ]}
      />
    )

    expect(screen.queryByRole('link', { name: '詳細を見る' })).not.toBeInTheDocument()
  })
})
