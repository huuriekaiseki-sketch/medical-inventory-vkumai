import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProductList } from '../ProductList'
import type { Product } from '@/types/product'

const products = [
  { id: '1', jan: '4900000000001', ref: 'REF-1', name: 'カテーテルAB型', maker: 'テルモ' },
  { id: '2', jan: '4900000000002', ref: 'REF-2', name: 'カテーテルCD型', maker: null },
] as unknown as Product[]

describe('ProductList', () => {
  it('製品一覧が表示される', () => {
    render(<ProductList products={products} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('4900000000001')).toBeInTheDocument()
    expect(screen.getByText('REF-2')).toBeInTheDocument()
  })

  it('製品名・メーカー名の列が表示される', () => {
    render(<ProductList products={products} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('製品名')).toBeInTheDocument()
    expect(screen.getByText('メーカー名')).toBeInTheDocument()
    expect(screen.getByText('カテーテルAB型')).toBeInTheDocument()
    expect(screen.getByText('テルモ')).toBeInTheDocument()
  })

  it('makerがnullの行は「—」で表示される', () => {
    render(<ProductList products={products} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('カテーテルCD型')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(1)
  })

  it('空のとき「製品が登録されていません」が表示される', () => {
    render(<ProductList products={[]} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('製品が登録されていません')).toBeInTheDocument()
  })

  it('編集ボタンはホバーしてもonMouseEnterのインラインstyle操作を持たない', () => {
    render(<ProductList products={products} onEdit={vi.fn()} onDelete={vi.fn()} />)
    const editBtn = screen.getAllByRole('button', { name: '編集' })[0]
    // ホバー前後でクラッシュせず、ホバー後にホバー用クラスが付くこと
    fireEvent.mouseEnter(editBtn)
    expect(editBtn.className).toMatch(/is-hover|hover-on/)
    fireEvent.mouseLeave(editBtn)
    expect(editBtn.className).not.toMatch(/is-hover|hover-on/)
  })
})
