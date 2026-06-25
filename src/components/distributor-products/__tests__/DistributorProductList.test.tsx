import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DistributorProductList } from '../DistributorProductList'
import type { DistributorProduct } from '@/types/distributorProduct'
import type { Category } from '@/types/category'

const categories = [{ id: 'cat-1', name: 'カテーテル' }] as unknown as Category[]
const items = [
  { id: '1', name: '商品A', maker: 'メーカーA', supplier: '仕入先A', categoryId: 'cat-1', reimbursementPrice: 1000, quantity: 5 },
] as unknown as DistributorProduct[]

describe('DistributorProductList', () => {
  it('販売店商品一覧が表示される', () => {
    render(<DistributorProductList items={items} categories={categories} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('商品A')).toBeInTheDocument()
    expect(screen.getByText('カテーテル')).toBeInTheDocument()
  })

  it('空のとき「販売店商品が登録されていません」が表示される', () => {
    render(<DistributorProductList items={[]} categories={categories} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('販売店商品が登録されていません')).toBeInTheDocument()
  })

  it('削除ボタンがホバーでホバー用クラスを付け外しする', () => {
    render(<DistributorProductList items={items} categories={categories} onEdit={vi.fn()} onDelete={vi.fn()} />)
    const delBtn = screen.getAllByRole('button', { name: '削除' })[0]
    fireEvent.mouseEnter(delBtn)
    expect(delBtn.className).toMatch(/is-hover|hover-on/)
    fireEvent.mouseLeave(delBtn)
    expect(delBtn.className).not.toMatch(/is-hover|hover-on/)
  })
})
