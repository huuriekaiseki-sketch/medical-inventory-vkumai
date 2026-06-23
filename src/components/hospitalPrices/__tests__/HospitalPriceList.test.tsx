import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HospitalPriceList } from '../HospitalPriceList'
import type { HospitalPrice } from '@/types/hospitalPrice'

const prices: (HospitalPrice & { facilityName: string; productName: string })[] = [
  {
    id: '1',
    distributorProductId: 'dp1',
    facilityId: 'f1',
    purchasePrice: 1000,
    deliveryPrice: 1500,
    grossProfit: 500,
    purchaseRate: 0.8,
    deliveryRate: 0.96,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    facilityName: '中央病院',
    productName: 'カテーテルA',
  },
  {
    id: '2',
    distributorProductId: 'dp2',
    facilityId: 'f2',
    purchasePrice: 20000,
    deliveryPrice: 25000,
    grossProfit: 5000,
    purchaseRate: null,
    deliveryRate: null,
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-02-01T00:00:00Z',
    facilityName: '東クリニック',
    productName: 'ガーゼB',
  },
]

describe('HospitalPriceList', () => {
  it('価格一覧が表示される（施設名・商品名・仕切値・納品価格）', () => {
    render(<HospitalPriceList prices={prices} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('中央病院')).toBeInTheDocument()
    expect(screen.getByText('カテーテルA')).toBeInTheDocument()
    expect(screen.getByText('1,000')).toBeInTheDocument()
    expect(screen.getByText('1,500')).toBeInTheDocument()
    expect(screen.getByText('東クリニック')).toBeInTheDocument()
    expect(screen.getByText('ガーゼB')).toBeInTheDocument()
    expect(screen.getByText('20,000')).toBeInTheDocument()
    expect(screen.getByText('25,000')).toBeInTheDocument()
  })

  it('粗利がDBの値（grossProfit）で表示される', () => {
    render(<HospitalPriceList prices={prices} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('500')).toBeInTheDocument()
    expect(screen.getByText('5,000')).toBeInTheDocument()
  })

  it('掛け率が数値のとき % 表示される（小数点1桁）', () => {
    render(<HospitalPriceList prices={prices} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getAllByText('80.0%')).toHaveLength(1)
    expect(screen.getAllByText('96.0%')).toHaveLength(1)
  })

  it('掛け率が null のとき「—」が表示される', () => {
    render(<HospitalPriceList prices={prices} onEdit={vi.fn()} onDelete={vi.fn()} />)
    const dashes = screen.getAllByText('—')
    expect(dashes.length).toBeGreaterThanOrEqual(2)
  })

  it('空のとき「価格情報が登録されていません」が表示される', () => {
    render(<HospitalPriceList prices={[]} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('価格情報が登録されていません')).toBeInTheDocument()
  })

  it('編集ボタンクリックで onEdit が呼ばれる', async () => {
    const onEdit = vi.fn()
    render(<HospitalPriceList prices={prices} onEdit={onEdit} onDelete={vi.fn()} />)
    await userEvent.click(screen.getAllByText('編集')[0])
    expect(onEdit).toHaveBeenCalledWith('1')
  })

  it('削除ボタンクリックで onDelete が呼ばれる', async () => {
    const onDelete = vi.fn()
    render(<HospitalPriceList prices={prices} onEdit={vi.fn()} onDelete={onDelete} />)
    await userEvent.click(screen.getAllByText('削除')[0])
    expect(onDelete).toHaveBeenCalledWith('1')
  })
})
