import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PriceHistoryList } from '../PriceHistoryList'
import type { PriceHistory } from '@/types/priceHistory'

const mockItems: PriceHistory[] = [
  {
    id: 'hist-1',
    entityType: 'distributor_product',
    entityId: 'dp-1',
    distributorProductId: 'dp-1',
    fieldName: 'reimbursement_price',
    oldValue: 1000,
    newValue: 1200,
    changedAt: '2026-06-22T10:00:00Z',
    facilityName: null,
  },
  {
    id: 'hist-2',
    entityType: 'hospital_price',
    entityId: 'hp-1',
    distributorProductId: 'dp-1',
    fieldName: 'purchase_price',
    oldValue: 800,
    newValue: 900,
    changedAt: '2026-06-21T09:00:00Z',
    facilityName: 'A病院',
  },
]

describe('PriceHistoryList', () => {
  it('変更前・後・種別を一覧表示する', () => {
    render(<PriceHistoryList items={mockItems} />)
    expect(screen.getByText('¥1,000')).toBeInTheDocument()
    expect(screen.getByText('¥1,200')).toBeInTheDocument()
    expect(screen.getByText('施設価格（A病院）')).toBeInTheDocument()
  })

  it('0 件のとき「変更履歴はありません」を表示する', () => {
    render(<PriceHistoryList items={[]} />)
    expect(screen.getByText('変更履歴はありません')).toBeInTheDocument()
  })

  it('行をクリックすると詳細が展開される', () => {
    render(<PriceHistoryList items={mockItems} />)
    const row = screen.getByText('¥1,000').closest('tr')!
    fireEvent.click(row)
    expect(screen.getByText('hist-1')).toBeInTheDocument()
  })

  it('施設が削除済みの場合「施設情報なし」と表示する', () => {
    const items: PriceHistory[] = [
      {
        ...mockItems[1],
        facilityName: null,
      },
    ]
    render(<PriceHistoryList items={items} />)
    expect(screen.getByText('施設価格（施設情報なし）')).toBeInTheDocument()
  })

  it('distributor_productの場合フィールド列は「—」を表示する', () => {
    render(<PriceHistoryList items={[mockItems[0]]} />)
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })
})
