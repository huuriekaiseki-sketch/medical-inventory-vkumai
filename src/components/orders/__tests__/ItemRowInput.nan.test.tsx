import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ItemRowInput, type ItemRow } from '../ItemRowInput'

describe('ItemRowInput quantity NaNガード', () => {
  const rows: ItemRow[] = [{ jan: '', lot: '', ubd: '', quantity: 1 }]

  it('数量を空文字にしてもNaNではなく0以上の数値がonChangeに渡る', () => {
    const onChange = vi.fn()
    render(<ItemRowInput rows={rows} onChange={onChange} />)
    const qty = screen.getByDisplayValue('1')
    fireEvent.change(qty, { target: { value: '' } })
    expect(onChange).toHaveBeenCalled()
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as ItemRow[]
    expect(Number.isNaN(last[0].quantity)).toBe(false)
  })
})
