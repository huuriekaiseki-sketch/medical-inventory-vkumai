import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { ProductList } from '@/components/products/ProductList'
import type { Product } from '@/types/product'

const mockProducts: Product[] = [
  {
    id: '1',
    name: '滅菌ガーゼ',
    code: 'GA-001',
    category: '消耗品',
    unit: '枚',
    unitPrice: 1000,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: '2',
    name: '注射針',
    code: 'NE-002',
    category: '機器',
    unit: '本',
    unitPrice: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: '3',
    name: 'MRI造影剤',
    code: 'MR-003',
    category: '試薬',
    unit: 'mL',
    unitPrice: 25000,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
]

describe('ProductList', () => {
  const defaultProps = {
    products: mockProducts,
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  }

  it('製品データがテーブルに正しく表示される', () => {
    render(<ProductList {...defaultProps} />)

    // カラムヘッダー
    expect(screen.getByText('製品名')).toBeInTheDocument()
    expect(screen.getByText('製品コード')).toBeInTheDocument()
    expect(screen.getByText('カテゴリ')).toBeInTheDocument()
    expect(screen.getByText('単位')).toBeInTheDocument()
    expect(screen.getByText('単価')).toBeInTheDocument()
    expect(screen.getByText('操作')).toBeInTheDocument()

    // 1行目のデータ
    expect(screen.getByText('滅菌ガーゼ')).toBeInTheDocument()
    expect(screen.getByText('GA-001')).toBeInTheDocument()
    expect(screen.getByText('消耗品')).toBeInTheDocument()
    expect(screen.getByText('枚')).toBeInTheDocument()

    // 2行目のデータ
    expect(screen.getByText('注射針')).toBeInTheDocument()
    expect(screen.getByText('NE-002')).toBeInTheDocument()

    // 3行目のデータ
    expect(screen.getByText('MRI造影剤')).toBeInTheDocument()
    expect(screen.getByText('MR-003')).toBeInTheDocument()
  })

  it('単価がnullの場合「-」を表示する', () => {
    render(<ProductList {...defaultProps} />)

    // 注射針の単価はnull → 「-」
    const rows = screen.getAllByRole('row')
    // ヘッダー行 + データ3行 = 4行
    expect(rows).toHaveLength(4)

    // 2行目（index 2）の注射針の行に「-」がある
    const needleRow = rows[2]
    expect(needleRow).toHaveTextContent('-')
  })

  it('単価が数値の場合カンマ区切りで「¥」付きで表示する', () => {
    render(<ProductList {...defaultProps} />)

    expect(screen.getByText('¥1,000')).toBeInTheDocument()
    expect(screen.getByText('¥25,000')).toBeInTheDocument()
  })

  it('編集ボタンクリックでonEditが正しいidで呼ばれる', async () => {
    const onEdit = vi.fn()
    const user = userEvent.setup()
    render(<ProductList {...defaultProps} onEdit={onEdit} />)

    const editButtons = screen.getAllByRole('button', { name: '編集' })
    expect(editButtons).toHaveLength(3)

    await user.click(editButtons[0])
    expect(onEdit).toHaveBeenCalledWith('1')

    await user.click(editButtons[1])
    expect(onEdit).toHaveBeenCalledWith('2')
  })

  it('削除ボタンクリックでonDeleteが正しいidで呼ばれる', async () => {
    const onDelete = vi.fn()
    const user = userEvent.setup()
    render(<ProductList {...defaultProps} onDelete={onDelete} />)

    const deleteButtons = screen.getAllByRole('button', { name: '削除' })
    expect(deleteButtons).toHaveLength(3)

    await user.click(deleteButtons[1])
    expect(onDelete).toHaveBeenCalledWith('2')
  })

  it('空リストで「製品が登録されていません」が表示される', () => {
    render(<ProductList products={[]} onEdit={vi.fn()} onDelete={vi.fn()} />)

    expect(screen.getByText('製品が登録されていません')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
