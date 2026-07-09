import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NewsFeedList } from '../NewsFeedList'
import type { NewsFeedItem } from '@/types/newsFeedItem'

const priceChangeItem: NewsFeedItem = {
  id: 'ph-1',
  eventType: 'hospital_price_change',
  occurredAt: '2026-07-08T01:00:00Z',
  distributorProductId: 'dp-1',
  productName: 'テスト商品A',
  maker: 'メーカーA',
  supplier: '仕入先A',
  fieldName: 'purchase_price',
  oldValue: 1000,
  newValue: 1200,
  facilityName: 'テスト施設A',
}

const newProductItem: NewsFeedItem = {
  id: 'new_product_dp-2',
  eventType: 'new_product',
  occurredAt: '2026-07-08T02:00:00Z',
  distributorProductId: 'dp-2',
  productName: 'テスト商品B',
  maker: 'メーカーB',
  supplier: '仕入先B',
  fieldName: null,
  oldValue: null,
  newValue: null,
  facilityName: null,
}

describe('NewsFeedList', () => {
  it('0件の場合は空状態メッセージを表示する', () => {
    render(<NewsFeedList items={[]} />)
    expect(screen.getByText('お知らせはありません')).toBeInTheDocument()
  })

  it('価格改定イベントを商品名・変更前後価格・施設名付きで表示する', () => {
    render(<NewsFeedList items={[priceChangeItem]} />)
    expect(screen.getByText('テスト商品A', { exact: false })).toBeInTheDocument()
    expect(screen.getByText(/¥1,000/)).toBeInTheDocument()
    expect(screen.getByText(/¥1,200/)).toBeInTheDocument()
    expect(screen.getByText(/テスト施設A/)).toBeInTheDocument()
  })

  it('新製品登録イベントは価格情報を表示せずメーカー・仕入先を表示する', () => {
    render(<NewsFeedList items={[newProductItem]} />)
    expect(screen.getByText('テスト商品B', { exact: false })).toBeInTheDocument()
    expect(screen.getByText(/メーカーB/)).toBeInTheDocument()
    expect(screen.queryByText(/¥/)).not.toBeInTheDocument()
  })
})
