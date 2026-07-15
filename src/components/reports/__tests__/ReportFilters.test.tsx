import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReportFilters } from '../ReportFilters'

describe('ReportFilters', () => {
  it('開始日・終了日の初期値が表示される', () => {
    render(<ReportFilters dateFrom="2026-01-01" dateTo="2026-01-31" onSubmit={vi.fn()} />)
    expect(screen.getByLabelText('開始日')).toHaveValue('2026-01-01')
    expect(screen.getByLabelText('終了日')).toHaveValue('2026-01-31')
  })

  it('「集計する」押下で入力値がonSubmitに渡される', async () => {
    const onSubmit = vi.fn()
    render(<ReportFilters dateFrom="" dateTo="" onSubmit={onSubmit} />)

    await userEvent.type(screen.getByLabelText('開始日'), '2026-01-01')
    await userEvent.type(screen.getByLabelText('終了日'), '2026-01-31')
    await userEvent.click(screen.getByRole('button', { name: '集計する' }))

    expect(onSubmit).toHaveBeenCalledWith({ dateFrom: '2026-01-01', dateTo: '2026-01-31' })
  })

  it('開始日が終了日より後の場合はバリデーションエラーを表示しonSubmitを呼ばない', async () => {
    const onSubmit = vi.fn()
    render(<ReportFilters dateFrom="" dateTo="" onSubmit={onSubmit} />)

    await userEvent.type(screen.getByLabelText('開始日'), '2026-02-01')
    await userEvent.type(screen.getByLabelText('終了日'), '2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: '集計する' }))

    expect(await screen.findByText('開始日は終了日より前の日付を指定してください')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('開始日・終了日とも未入力でも集計できる（全期間扱い）', async () => {
    const onSubmit = vi.fn()
    render(<ReportFilters dateFrom="" dateTo="" onSubmit={onSubmit} />)

    await userEvent.click(screen.getByRole('button', { name: '集計する' }))

    expect(onSubmit).toHaveBeenCalledWith({ dateFrom: '', dateTo: '' })
  })
})
