import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HospitalPriceForm } from '../HospitalPriceForm'
import type { Facility } from '@/types/facility'
import type { DistributorProduct } from '@/types/distributorProduct'

const facilities: Facility[] = [
  { id: 'f1', name: '中央病院', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]

const distributorProducts: DistributorProduct[] = [
  {
    id: 'dp1',
    productId: 'p1',
    maker: 'メーカーA',
    supplier: '代理店A',
    name: 'カテーテルA',
    reimbursementPrice: 2000,
    quantity: 1,
    category: '消耗品',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
]

describe('HospitalPriceForm', () => {
  it('施設が空のとき警告メッセージが表示される', () => {
    render(
      <HospitalPriceForm
        facilities={[]}
        distributorProducts={distributorProducts}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByText(/施設が登録されていません/)).toBeInTheDocument()
  })

  it('施設が空のとき保存ボタンが disabled になる', () => {
    render(
      <HospitalPriceForm
        facilities={[]}
        distributorProducts={distributorProducts}
        onSubmit={vi.fn()}
        submitLabel="登録"
      />,
    )
    expect(screen.getByRole('button', { name: '登録' })).toBeDisabled()
  })

  it('フォーム送信で onSubmit が正しい値（数値型）で呼ばれる', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <HospitalPriceForm
        facilities={facilities}
        distributorProducts={distributorProducts}
        onSubmit={onSubmit}
        submitLabel="登録"
      />,
    )

    await userEvent.selectOptions(screen.getByLabelText('施設'), 'f1')
    await userEvent.selectOptions(screen.getByLabelText('代理店商品'), 'dp1')
    await userEvent.type(screen.getByLabelText('仕切値（円）'), '1000')
    await userEvent.type(screen.getByLabelText('納品価格（円）'), '1500')
    await userEvent.click(screen.getByRole('button', { name: '登録' }))

    expect(onSubmit).toHaveBeenCalledWith({
      facilityId: 'f1',
      distributorProductId: 'dp1',
      purchasePrice: 1000,
      deliveryPrice: 1500,
    })
  })
})
