import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ItemRowInput, type ItemRow } from '../ItemRowInput'

describe('ItemRowInput', () => {
  const defaultRows: ItemRow[] = [{ jan: '', lot: '', ubd: '', quantity: 1 }]

  it('初期行のJAN/LOT/UBD/数量フィールドが表示される', () => {
    render(<ItemRowInput rows={defaultRows} onChange={vi.fn()} />)
    expect(screen.getByPlaceholderText('JAN')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('LOT')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('UBD')).toBeInTheDocument()
  })

  it('「+ 行を追加」クリックでonChangeが2行配列で呼ばれる', async () => {
    const onChange = vi.fn()
    render(<ItemRowInput rows={defaultRows} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: '+ 行を追加' }))
    expect(onChange).toHaveBeenCalledWith([
      { jan: '', lot: '', ubd: '', quantity: 1 },
      { jan: '', lot: '', ubd: '', quantity: 1 },
    ])
  })

  it('JANフィールドへの入力でonChangeが呼ばれる', async () => {
    const onChange = vi.fn()
    render(<ItemRowInput rows={defaultRows} onChange={onChange} />)
    await userEvent.type(screen.getByPlaceholderText('JAN'), 'A')
    expect(onChange).toHaveBeenLastCalledWith([{ jan: 'A', lot: '', ubd: '', quantity: 1 }])
  })

  it('削除ボタンで行が取り除かれたonChangeが呼ばれる', async () => {
    const onChange = vi.fn()
    const rows: ItemRow[] = [
      { jan: 'A', lot: '', ubd: '', quantity: 1 },
      { jan: 'B', lot: '', ubd: '', quantity: 2 },
    ]
    render(<ItemRowInput rows={rows} onChange={onChange} />)
    const deleteButtons = screen.getAllByRole('button', { name: '削除' })
    await userEvent.click(deleteButtons[0])
    expect(onChange).toHaveBeenCalledWith([{ jan: 'B', lot: '', ubd: '', quantity: 2 }])
  })
})
