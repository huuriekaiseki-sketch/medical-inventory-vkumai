import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OrderHistoryTable } from '../OrderHistoryTable'
import type { UnifiedOrder, OrdersFetchError } from '@/types/order'

const baseOrder: UnifiedOrder = {
  id: 'o1',
  kind: 'case',
  facilityId: 'f1',
  facilityName: 'テスト施設A',
  displayDatetime: '2026-07-10T01:00:00Z',
  status: 'submitted',
  summaryLabel: 'テスト製品A 他2件',
}

const orders: UnifiedOrder[] = [
  baseOrder,
  {
    id: 'o2',
    kind: 'loan_return',
    facilityId: 'f2',
    facilityName: 'テスト施設B',
    displayDatetime: '2026-07-09T01:00:00Z',
    status: 'returned',
    summaryLabel: 'テスト製品B',
  },
]

function getDetailHref(order: UnifiedOrder) {
  return `/facilities/${order.facilityId}/case-orders`
}

describe('OrderHistoryTable', () => {
  it('ordersが空の場合、データなしメッセージを表示する', () => {
    render(
      <OrderHistoryTable
        orders={[]}
        errors={[]}
        loading={false}
        showFacilityColumn={false}
        getDetailHref={getDetailHref}
      />
    )
    expect(screen.getByText('該当する発注履歴がありません')).toBeInTheDocument()
  })

  it('errorsが空でない場合、部分取得失敗バナーを表示する', () => {
    const errors: OrdersFetchError[] = [{ kind: 'loan', message: 'timeout' }]
    render(
      <OrderHistoryTable
        orders={orders}
        errors={errors}
        loading={false}
        showFacilityColumn={false}
        getDetailHref={getDetailHref}
      />
    )
    expect(screen.getByText('一部の発注種別を取得できませんでした')).toBeInTheDocument()
  })

  it('errorsが空の場合、部分取得失敗バナーを表示しない', () => {
    render(
      <OrderHistoryTable
        orders={orders}
        errors={[]}
        loading={false}
        showFacilityColumn={false}
        getDetailHref={getDetailHref}
      />
    )
    expect(screen.queryByText('一部の発注種別を取得できませんでした')).not.toBeInTheDocument()
  })

  it('loading中はスケルトンを表示し、データ行は表示しない', () => {
    render(
      <OrderHistoryTable
        orders={[]}
        errors={[]}
        loading={true}
        showFacilityColumn={false}
        getDetailHref={getDetailHref}
      />
    )
    expect(screen.getByTestId('order-history-skeleton')).toBeInTheDocument()
    expect(screen.queryByText('該当する発注履歴がありません')).not.toBeInTheDocument()
  })

  it('showFacilityColumn=trueの場合、施設名カラムを表示する', () => {
    render(
      <OrderHistoryTable
        orders={orders}
        errors={[]}
        loading={false}
        showFacilityColumn={true}
        getDetailHref={getDetailHref}
      />
    )
    expect(screen.getByRole('columnheader', { name: '施設名' })).toBeInTheDocument()
    expect(screen.getByText('テスト施設A')).toBeInTheDocument()
    expect(screen.getByText('テスト施設B')).toBeInTheDocument()
  })

  it('showFacilityColumn=falseの場合、施設名カラムを表示しない', () => {
    render(
      <OrderHistoryTable
        orders={orders}
        errors={[]}
        loading={false}
        showFacilityColumn={false}
        getDetailHref={getDetailHref}
      />
    )
    expect(screen.queryByRole('columnheader', { name: '施設名' })).not.toBeInTheDocument()
  })

  it('各行に製品名サマリーとステータス・詳細リンクを表示する', () => {
    render(
      <OrderHistoryTable
        orders={orders}
        errors={[]}
        loading={false}
        showFacilityColumn={false}
        getDetailHref={getDetailHref}
      />
    )
    expect(screen.getByText('テスト製品A 他2件')).toBeInTheDocument()
    expect(screen.getByText('テスト製品B')).toBeInTheDocument()
    const links = screen.getAllByRole('link', { name: '詳細' })
    expect(links).toHaveLength(2)
    expect(links[0]).toHaveAttribute('href', '/facilities/f1/case-orders')
  })

  it('テーブル見出しにscope=col属性が設定される', () => {
    render(
      <OrderHistoryTable
        orders={orders}
        errors={[]}
        loading={false}
        showFacilityColumn={true}
        getDetailHref={getDetailHref}
      />
    )
    const headers = screen.getAllByRole('columnheader')
    headers.forEach((header) => {
      expect(header).toHaveAttribute('scope', 'col')
    })
  })

  it('getDetailHrefが呼ばれ、各注文に対して個別に評価される', () => {
    const spy = vi.fn(getDetailHref)
    render(
      <OrderHistoryTable
        orders={orders}
        errors={[]}
        loading={false}
        showFacilityColumn={false}
        getDetailHref={spy}
      />
    )
    expect(spy).toHaveBeenCalledTimes(orders.length)
  })
})
