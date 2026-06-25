import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CaseOrderModal } from '../CaseOrderModal'

describe('CaseOrderModal 空送信防止', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ order: { id: 'co-1' } }),
    })
  })

  it('全フィールド空のまま送信するとfetchが呼ばれずエラーが表示される', async () => {
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(fetch).not.toHaveBeenCalled()
    expect(await screen.findByText('手技名を入力してください')).toBeInTheDocument()
  })
})
