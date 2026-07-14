import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ItemRowInput, type ItemRow } from '../ItemRowInput'

describe('ItemRowInput', () => {
  const defaultRows: ItemRow[] = [{ id: 'row-1', jan: '', lot: '', ubd: '', quantity: 1 }]

  it('初期行のJAN/LOT/UBD/数量フィールドが表示される', () => {
    render(<ItemRowInput rows={defaultRows} onChange={vi.fn()} />)
    expect(screen.getByPlaceholderText('JAN')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('LOT')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('UBD')).toBeInTheDocument()
  })

  it('「+ 行を追加」クリックでonChangeが2行配列で呼ばれ、新規行に一意なidが付与される', async () => {
    const onChange = vi.fn()
    render(<ItemRowInput rows={defaultRows} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: '+ 行を追加' }))
    const result = onChange.mock.calls[0][0] as ItemRow[]
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(defaultRows[0])
    expect(result[1]).toMatchObject({ jan: '', lot: '', ubd: '', quantity: 1 })
    expect(result[1].id).toBeTruthy()
    expect(result[1].id).not.toBe(result[0].id)
  })

  it('JANフィールドへの入力でonChangeが呼ばれる', async () => {
    const onChange = vi.fn()
    render(<ItemRowInput rows={defaultRows} onChange={onChange} />)
    await userEvent.type(screen.getByPlaceholderText('JAN'), 'A')
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'row-1', jan: 'A', lot: '', ubd: '', quantity: 1 }])
  })

  it('削除ボタンで行が取り除かれたonChangeが呼ばれる', async () => {
    const onChange = vi.fn()
    const rows: ItemRow[] = [
      { id: 'row-1', jan: 'A', lot: '', ubd: '', quantity: 1 },
      { id: 'row-2', jan: 'B', lot: '', ubd: '', quantity: 2 },
    ]
    render(<ItemRowInput rows={rows} onChange={onChange} />)
    const deleteButtons = screen.getAllByRole('button', { name: '削除' })
    await userEvent.click(deleteButtons[0])
    expect(onChange).toHaveBeenCalledWith([{ id: 'row-2', jan: 'B', lot: '', ubd: '', quantity: 2 }])
  })

  it('行削除時、残った行のidが保持される（配列インデックスkeyによる状態崩れの回帰防止）', async () => {
    const onChange = vi.fn()
    const rows: ItemRow[] = [
      { id: 'row-1', jan: 'A', lot: '', ubd: '', quantity: 1 },
      { id: 'row-2', jan: 'B', lot: '', ubd: '', quantity: 2 },
      { id: 'row-3', jan: 'C', lot: '', ubd: '', quantity: 3 },
    ]
    render(<ItemRowInput rows={rows} onChange={onChange} />)
    const deleteButtons = screen.getAllByRole('button', { name: '削除' })
    await userEvent.click(deleteButtons[0])
    const result = onChange.mock.calls[0][0] as ItemRow[]
    expect(result.map(r => r.id)).toEqual(['row-2', 'row-3'])
  })
})
