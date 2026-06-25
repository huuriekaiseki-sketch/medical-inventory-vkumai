import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CategoryList } from '../CategoryList'
import type { Category } from '@/types/category'

const categories = [
  { id: '1', name: 'カテーテル', description: '説明A', createdAt: '2026-01-01T00:00:00Z' },
  { id: '2', name: 'ステント', description: null, createdAt: '2026-02-01T00:00:00Z' },
] as unknown as Category[]

describe('CategoryList', () => {
  it('カテゴリ一覧が表示される', () => {
    render(<CategoryList categories={categories} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('カテーテル')).toBeInTheDocument()
    expect(screen.getByText('ステント')).toBeInTheDocument()
  })

  it('空のとき「カテゴリが登録されていません」が表示される', () => {
    render(<CategoryList categories={[]} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('カテゴリが登録されていません')).toBeInTheDocument()
  })

  it('編集ボタンがホバーでホバー用クラスを付け外しする', () => {
    render(<CategoryList categories={categories} onEdit={vi.fn()} onDelete={vi.fn()} />)
    const editBtn = screen.getAllByRole('button', { name: '編集' })[0]
    fireEvent.mouseEnter(editBtn)
    expect(editBtn.className).toMatch(/is-hover|hover-on/)
    fireEvent.mouseLeave(editBtn)
    expect(editBtn.className).not.toMatch(/is-hover|hover-on/)
  })
})
