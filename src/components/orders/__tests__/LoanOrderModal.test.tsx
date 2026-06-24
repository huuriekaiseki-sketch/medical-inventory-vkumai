import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LoanOrderModal } from '../LoanOrderModal'

describe('LoanOrderModal', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ order: { id: 'lo-1' } }),
    })
  })

  it('isOpen=falseのとき何も描画しない', () => {
    render(<LoanOrderModal facilityId="f-1" isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(screen.queryByText('短貸発注')).not.toBeInTheDocument()
  })

  it('手技名・メーカー・物品リストが表示される', () => {
    render(<LoanOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '短貸発注' })).toBeInTheDocument()
    expect(screen.getByLabelText(/手技名/)).toBeInTheDocument()
    expect(screen.getByLabelText(/メーカー/)).toBeInTheDocument()
  })

  it('フォーム送信でPOST /api/loan-ordersが呼ばれる', async () => {
    const onSuccess = vi.fn()
    render(<LoanOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={onSuccess} />)
    await userEvent.type(screen.getByLabelText(/手技名/), 'TAVI')
    await userEvent.type(screen.getByLabelText(/メーカー/), 'メドトロニック')
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(fetch).toHaveBeenCalledWith('/api/loan-orders', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.procedureName).toBe('TAVI')
    expect(body.maker).toBe('メドトロニック')
    expect(onSuccess).toHaveBeenCalled()
  })
})
