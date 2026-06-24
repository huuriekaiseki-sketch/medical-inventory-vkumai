import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LoanReturnModal } from '../LoanReturnModal'

describe('LoanReturnModal', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ loanReturn: { id: 'lr-1' } }),
    })
  })

  it('isOpen=falseのとき何も描画しない', () => {
    render(<LoanReturnModal facilityId="f-1" isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(screen.queryByText('短貸返却')).not.toBeInTheDocument()
  })

  it('返却日時とJAN/LOT/UBD入力欄が表示される', () => {
    render(<LoanReturnModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '短貸返却' })).toBeInTheDocument()
    expect(screen.getByLabelText(/返却日時/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('JAN')).toBeInTheDocument()
  })

  it('フォーム送信でPOST /api/loan-returnsが呼ばれる', async () => {
    const onSuccess = vi.fn()
    render(<LoanReturnModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={onSuccess} />)
    await userEvent.type(screen.getByLabelText(/返却日時/), '2026-06-24T15:00')
    await userEvent.click(screen.getByRole('button', { name: '返却する' }))
    expect(fetch).toHaveBeenCalledWith('/api/loan-returns', expect.objectContaining({ method: 'POST' }))
    expect(onSuccess).toHaveBeenCalled()
  })
})
