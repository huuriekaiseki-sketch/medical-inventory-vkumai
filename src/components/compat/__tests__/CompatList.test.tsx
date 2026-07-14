import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CompatList } from '../CompatList'
import type { ProductCompatibility } from '@/types/compatibility'

const items: ProductCompatibility[] = [
  {
    id: 'c1',
    categoryId: 'cat1',
    categoryName: '縫合糸',
    productId1: 'p1',
    product1: { jan: '4900000000001', name: '製品A', maker: 'テルモ' },
    productId2: 'p2',
    product2: { jan: '4900000000002', name: '製品B', maker: null },
    note: '備考テキスト',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  },
]

describe('CompatList', () => {
  beforeEach(() => {
    vi.stubGlobal('confirm', vi.fn(() => true))
  })

  it('カラムヘッダーが表示される', () => {
    render(<CompatList items={items} isAdmin={false} onDelete={vi.fn()} hasFilter={false} />)
    expect(screen.getByText('カテゴリ名')).toBeInTheDocument()
    expect(screen.getByText('製品A')).toBeInTheDocument()
    expect(screen.getByText('製品B')).toBeInTheDocument()
    expect(screen.getByText('備考')).toBeInTheDocument()
    expect(screen.getByText('登録日')).toBeInTheDocument()
  })

  it('行に製品A/Bの名称・JAN・メーカーと備考が表示される', () => {
    render(<CompatList items={items} isAdmin={false} onDelete={vi.fn()} hasFilter={false} />)
    expect(screen.getByText('縫合糸')).toBeInTheDocument()
    expect(screen.getAllByText(/製品A/).length).toBeGreaterThan(0)
    expect(screen.getByText(/4900000000001/)).toBeInTheDocument()
    expect(screen.getByText(/テルモ/)).toBeInTheDocument()
    expect(screen.getByText(/4900000000002/)).toBeInTheDocument()
    expect(screen.getByText('備考テキスト')).toBeInTheDocument()
  })

  it('makerがnullのときは「不明」と表示する', () => {
    render(<CompatList items={items} isAdmin={false} onDelete={vi.fn()} hasFilter={false} />)
    expect(screen.getByText(/不明/)).toBeInTheDocument()
  })

  it('isAdmin=falseのとき削除ボタンが表示されない', () => {
    render(<CompatList items={items} isAdmin={false} onDelete={vi.fn()} hasFilter={false} />)
    expect(screen.queryByRole('button', { name: '削除' })).not.toBeInTheDocument()
  })

  it('isAdmin=trueのとき削除ボタンが表示され、確認ダイアログに製品情報が含まれる', async () => {
    const onDelete = vi.fn()
    render(<CompatList items={items} isAdmin={true} onDelete={onDelete} hasFilter={false} />)
    await userEvent.click(screen.getByRole('button', { name: '削除' }))
    expect(global.confirm).toHaveBeenCalledWith(
      expect.stringContaining('製品A（JAN 4900000000001 / メーカーテルモ）')
    )
    expect(global.confirm).toHaveBeenCalledWith(
      expect.stringContaining('製品B（JAN 4900000000002 / メーカー不明）')
    )
    expect(onDelete).toHaveBeenCalledWith('c1')
  })

  it('確認ダイアログでキャンセルするとonDeleteが呼ばれない', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    const onDelete = vi.fn()
    render(<CompatList items={items} isAdmin={true} onDelete={onDelete} hasFilter={false} />)
    await userEvent.click(screen.getByRole('button', { name: '削除' }))
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('全体0件かつ管理者のとき登録導線付きメッセージが表示される', () => {
    render(<CompatList items={[]} isAdmin={true} onDelete={vi.fn()} hasFilter={false} />)
    expect(screen.getByText('互換品が登録されていません')).toBeInTheDocument()
    expect(screen.getByText('＋互換品を追加')).toBeInTheDocument()
  })

  it('全体0件かつ一般ユーザーのときメッセージのみ表示される', () => {
    render(<CompatList items={[]} isAdmin={false} onDelete={vi.fn()} hasFilter={false} />)
    expect(screen.getByText('互換品はまだ登録されていません')).toBeInTheDocument()
    expect(screen.queryByText('＋互換品を追加')).not.toBeInTheDocument()
  })

  it('フィルタ結果0件のときは条件不一致メッセージが表示される', () => {
    render(<CompatList items={[]} isAdmin={true} onDelete={vi.fn()} hasFilter={true} />)
    expect(screen.getByText('条件に一致する互換品がありません')).toBeInTheDocument()
  })

  it('isLoading=trueのときスケルトンが表示される', () => {
    render(<CompatList items={[]} isAdmin={false} onDelete={vi.fn()} hasFilter={false} isLoading />)
    expect(screen.getByTestId('compat-list-skeleton')).toBeInTheDocument()
  })
})
