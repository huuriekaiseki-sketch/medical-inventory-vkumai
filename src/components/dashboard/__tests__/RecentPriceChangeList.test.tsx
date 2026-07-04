import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RecentPriceChangeList } from '../RecentPriceChangeList'
import type { RecentPriceChange } from '@/types/dashboard'

const items: RecentPriceChange[] = [
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
  {
    id: 'h2',
    entityType: 'hospital_price',
    entityId: 'hp1',
    distributorProductId: 'dp2',
    fieldName: 'purchase_price',
    oldValue: 500,
    newValue: 450,
    changedAt: '2026-06-01T00:00:00Z',
    productName: '製品B',
  },
]

describe('RecentPriceChangeList', () => {
  it('価格改定が新しい順に表示される', () => {
    render(<RecentPriceChangeList items={items} />)
    const names = screen.getAllByText(/製品/).map((el) => el.textContent)
    expect(names).toEqual(['製品A', '製品B'])
  })

  it('商品名・変更前後の値へのリンクが表示される', () => {
    render(<RecentPriceChangeList items={items} />)
    expect(screen.getByText('製品A')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '製品A' })).toHaveAttribute(
      'href',
      '/distributor-products/dp1/price-history'
    )
  })

  it('0件のとき「データがありません」が表示される', () => {
    render(<RecentPriceChangeList items={[]} />)
    expect(screen.getByText('データがありません')).toBeInTheDocument()
  })
})
